import { createHash } from "node:crypto";
import { readUpload } from "./upload.ts";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";

import { cashBalancesAt } from "../../core/cash.ts";
import { EUR, formatMoney, parseMoney, subMoney, zeroMoney, type Money } from "../../core/money.ts";
import { assertAccountOwned } from "../accounts.ts";
import { commitBankStatement } from "./bank-commit.ts";
import { matchesBank, OP_BANK, OP_CREDIT, parseBankStatement } from "./bank-statement.ts";
import type { BankStatementConfig } from "./bank-statement.ts";
import {
  BankDraft,
  bankDraftFromRows,
  bankDraftFromStatement,
  bankRowsFromDraft,
  checkBankDraft,
} from "./bank-draft.ts";
import { readBankPdfByRecipe } from "./recipe/read.ts";
import { unclaimedWorthReporting } from "./recipe/verify.ts";
import { type Db, db } from "../db/index.ts";
import { accounts, transactions } from "../db/schema.ts";
import { HttpError } from "../errors.ts";
import { loadPortfolio } from "../valuation.ts";
import { DEFAULT_CHAT_MODEL } from "../chat/models.ts";
import { createClient, type ChatClient } from "../chat/runner.ts";
import { classifyNewMerchants, type ClassifyResult } from "../spending/classify.ts";

/** Every bank format the app can read. A file is matched against each in turn. */
// The card log is tried first: its signature is the stricter of the two, and an
// account statement can never match it.
const BANK_CONFIGS: readonly BankStatementConfig[] = [OP_CREDIT, OP_BANK];

const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Päivämäärän on oltava muotoa YYYY-MM-DD");

/**
 * A parser's own complaint, as a 400 the caller can read. Anything that is not
 * an `Error` keeps the generic message rather than stringifying whatever it was.
 */
const asBadRequest = (cause: unknown): HttpError =>
  new HttpError(400, cause instanceof Error ? cause.message : "Tiliotetta ei voitu lukea");

/** A PDF announces itself in its first bytes; everything else is tried as CSV. */
const isPdf = (bytes: ArrayBuffer): boolean =>
  new TextDecoder().decode(bytes.slice(0, 5)) === "%PDF-";

/**
 * Reads whichever format arrived into one draft. A CSV parses by its bank's
 * config; a PDF is read by a recipe -- the owner's stored description of that
 * layout, or a fresh one the model writes. Neither is checked here: the check
 * belongs to the draft, which the owner may still edit.
 */
const readStatement = async (
  bytes: ArrayBuffer,
  userId: string,
): Promise<{ bank: string; draft: BankDraft }> => {
  if (!isPdf(bytes)) {
    const config = detect(bytes);
    const { rows, problems } = parseBankStatement(bytes, config);
    return { bank: config.bank, draft: bankDraftFromRows(rows, problems) };
  }
  try {
    const run = await readBankPdfByRecipe(bytes, userId, readerClient ?? createClient());
    return {
      bank: "pdf",
      draft: bankDraftFromStatement(run.statement, unclaimedWorthReporting(run)),
    };
  } catch (cause) {
    // The extractor's and the reader's complaints are the owner's to act on --
    // a scanned file, a reply the schema refused -- so they arrive as 400s.
    throw asBadRequest(cause);
  }
};

/** Injected by tests, so a PDF never reaches the real model. */
let readerClient: ChatClient | null = null;
export const _setReaderClient = (client: ChatClient | null): void => {
  readerClient = client;
};

const detect = (bytes: ArrayBuffer): BankStatementConfig => {
  const config = BANK_CONFIGS.find((candidate) => matchesBank(bytes, candidate));
  if (!config) throw new HttpError(400, "Tiedostoa ei tunnistettu tiliotteeksi");
  return config;
};

/**
 * A statement belongs on a bank account. Loading a year of card payments onto a
 * brokerage one would put spending into the ledger the returns are computed from.
 */
const assertBankAccount = async (accountId: number): Promise<void> => {
  const account = await db.select().from(accounts).where(eq(accounts.id, accountId)).get();
  if (account?.kind !== "bank") {
    throw new HttpError(400, "Tiliote voidaan tuoda vain pankkitilille");
  }
};

/**
 * Writes the opening balance a statement states, then checks the ledger against
 * the closing one. The check is the part worth having: the two agree by
 * construction unless the account already held rows for the period, which is what
 * happens when one month arrives as both a CSV and a PDF. Their archive ids
 * differ between the formats, so nothing else would catch the doubling.
 */
/**
 * Puts the statement's maturity date on the account when it has none. Filling a
 * blank is not overwriting a choice: an existing date is left alone and the
 * disagreement reported, since changed terms are worth looking at.
 */
/**
 * Classifies the merchants this account's spending does not yet have rules for.
 *
 * Skipped silently when the instance has no API key: classification is a
 * convenience on top of the import, not a condition of it.
 */
const classifyImportedSpending = async (
  db: Db,
  userId: string,
  accountId: number,
): Promise<ClassifyResult | null> => {
  const { txns } = await loadPortfolio(db, userId);
  return classifyNewMerchants(db, userId, {
    txns,
    accountIds: new Set([accountId]),
    client: classifierClient ?? createClient(),
    model: DEFAULT_CHAT_MODEL,
  });
};

/** Injected by tests, so classification never reaches the real API. */
let classifierClient: ChatClient | null = null;
export const _setClassifierClient = (client: ChatClient | null): void => {
  classifierClient = client;
};

/** What the reconciliation and the maturity note read off a statement. */
type StatementFacts = {
  readonly from: string;
  readonly to: string;
  readonly openingBalance: Money;
  readonly closingBalance: Money;
  readonly maturityDate: string | null;
};

const statementOf = (statement: NonNullable<BankDraft["statement"]>): StatementFacts => ({
  from: statement.from,
  to: statement.to,
  openingBalance: parseMoney(statement.openingBalanceEur, EUR),
  closingBalance: parseMoney(statement.closingBalanceEur, EUR),
  maturityDate: statement.maturityDate,
});

type MaturityOutcome = {
  /** What the account carries after this import. */
  readonly maturityDate: string | null;
  /** The statement's date when it disagrees with the account's own; null otherwise. */
  readonly maturityConflict: string | null;
};

const recordMaturity = async (
  db: Db,
  accountId: number,
  statement: StatementFacts,
): Promise<MaturityOutcome> => {
  const account = await db.select().from(accounts).where(eq(accounts.id, accountId)).get();
  const stated = statement.maturityDate;
  if (stated === null || account === undefined) {
    return { maturityDate: account?.maturityDate ?? null, maturityConflict: null };
  }
  if (account.accountType !== "fixed_term") {
    // A maturity date means nothing on a current account, and the account's kind
    // is the owner's to set, not a statement's.
    return { maturityDate: null, maturityConflict: null };
  }
  if (account.maturityDate === null) {
    await db.update(accounts).set({ maturityDate: stated }).where(eq(accounts.id, accountId)).run();
    return { maturityDate: stated, maturityConflict: null };
  }
  return {
    maturityDate: account.maturityDate,
    maturityConflict: account.maturityDate === stated ? null : stated,
  };
};

type Reconciliation = {
  readonly statedClosingEur: string;
  readonly ledgerClosingEur: string;
  readonly differenceEur: string;
  /**
   * False when an earlier statement had already established the opening
   * balance, so this import left it alone. Reported because "your opening
   * balance was not changed" is something the owner should be told rather than
   * left to infer from a figure that did not move.
   */
  readonly openingBalanceWritten: boolean;
  readonly openingBalanceDate: string;
};

const reconcileToStatement = async (
  db: Db,
  accountId: number,
  statement: StatementFacts,
): Promise<Reconciliation> => {
  const existing = await db
    .select({ id: transactions.id, tradeDate: transactions.tradeDate })
    .from(transactions)
    .where(
      and(
        eq(transactions.accountId, accountId),
        eq(transactions.type, "OPENING_BALANCE"),
        eq(transactions.currency, EUR),
      ),
    )
    .get();

  // An opening balance belongs to the earliest period anyone has imported, and
  // only a statement reaching further back may replace it.
  //
  // Overwriting on every import was a real defect: importing this year's
  // statement after an older one replaced "the account held nothing in 2024"
  // with a later balance, while the earlier rows
  // stayed in the ledger -- counting that period's money twice.
  const reachesFurtherBack = existing === undefined || statement.from < existing.tradeDate;

  if (reachesFurtherBack) {
    // Written even when it is zero. "The account held nothing on 31.12.2024"
    // is a fact, and the row is what carries its date -- without it, the next
    // statement imported finds no opening balance and writes its own later
    // one over a history that already reaches further back.
    const replacement = db.insert(transactions).values({
      accountId,
      instrumentId: null,
      type: "OPENING_BALANCE",
      tradeDate: statement.from,
      quantity: 0,
      unitPrice: null,
      amount: Number(statement.openingBalance.minor),
      fee: 0,
      tax: 0,
      currency: EUR,
      fxRateEur: 100_000_000,
      contentHash: `opening:${accountId}:EUR`,
      note: `Alkusaldo tiliotteelta ${statement.from}`,
    });

    // One batch, which D1 runs as a single transaction. The delete must not
    // land without the insert: an account with no opening balance at all
    // values its whole history from nothing.
    await (existing
      ? db.batch([db.delete(transactions).where(eq(transactions.id, existing.id)), replacement])
      : db.batch([replacement]));
  }

  const rows = await db
    .select({ amount: transactions.amount, tradeDate: transactions.tradeDate })
    .from(transactions)
    .where(eq(transactions.accountId, accountId))
    .all();
  const ledger = rows
    .filter((row) => row.tradeDate <= statement.to)
    .reduce((sum, row) => sum + BigInt(row.amount), 0n);

  return {
    statedClosingEur: formatMoney(statement.closingBalance),
    ledgerClosingEur: formatMoney({ minor: ledger, currency: EUR }),
    differenceEur: formatMoney({
      minor: statement.closingBalance.minor - ledger,
      currency: EUR,
    }),
    openingBalanceWritten: reachesFurtherBack,
    openingBalanceDate: reachesFurtherBack
      ? statement.from
      : (existing?.tradeDate ?? statement.from),
  };
};

/** The calendar day before `date`, in ISO form. */
const dayBefore = (date: string): string => {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() - 1);
  return parsed.toISOString().slice(0, 10);
};

export const BalanceInput = z
  .object({
    accountId: z.number().int().positive(),
    on: IsoDateSchema,
    balance: z.string().regex(/^-?\d+([.,]\d{1,2})?$/, "Saldo muodossa 1234.56"),
  })
  .strict();

export const previewBankStatement = async (userId: string, form: FormData) => {
  const { file, accountId } = readUpload(form);
  await assertAccountOwned(userId, accountId);
  await assertBankAccount(accountId);

  const bytes = await file.arrayBuffer();
  const { bank, draft } = await readStatement(bytes, userId);
  const sha256 = createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
  return { bank, filename: file.name, sha256, draft, check: checkBankDraft(draft) };
};

export const CommitBankDraft = z
  .object({
    accountId: z.number().int().positive(),
    filename: z.string().min(1).max(255),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    draft: BankDraft,
  })
  .strict();

/**
 * Commits the rows the owner reviewed -- and possibly corrected -- in the
 * preview. The file is not read again: the draft is the statement now.
 */
export const commitBankDraft = async (userId: string, body: z.infer<typeof CommitBankDraft>) => {
  const { accountId, filename, sha256, draft } = CommitBankDraft.parse(body);
  await assertAccountOwned(userId, accountId);
  await assertBankAccount(accountId);
  if (draft.rows.length === 0)
    throw new HttpError(400, "Tiedostosta ei löytynyt yhtään tapahtumaa");

  const check = checkBankDraft(draft);
  if (check !== null && !check.ok) {
    throw new HttpError(
      400,
      `Tiliotteen rivit eivät täsmää sen omaan loppusaldoon (ero ${check.differenceEur} €). ` +
        "Korjaa rivit esikatselussa ennen tuontia.",
    );
  }

  const rows = bankRowsFromDraft(draft);
  const result = await commitBankStatement(db, { userId, accountId, filename, sha256, rows });

  const statement = draft.statement === null ? null : statementOf(draft.statement);
  const reconciliation =
    statement === null ? null : await reconcileToStatement(db, accountId, statement);
  const maturity = statement === null ? null : await recordMaturity(db, accountId, statement);

  // Whatever this file named that no rule covers is put to the model once, and
  // what it proposes becomes rules for next time. Failure is reported rather
  // than thrown: the rows are already in.
  const classified = await classifyImportedSpending(db, userId, accountId);

  // Problems travel with the result rather than blocking it: a statement whose
  // 700th row is malformed should still import the other 699.
  return {
    ...result,
    problems: draft.problems.map((problem) => ({ line: problem.line, message: problem.text })),
    reconciliation,
    classified,
    maturityDate: maturity?.maturityDate ?? null,
    maturityConflict: maturity?.maturityConflict ?? null,
  };
};

/**
 * The upload-and-commit path `cash.tsx` still calls (Task 10 moves the screen
 * onto the preview-then-`commitBankDraft` flow above and this pair is
 * deleted). Kept working as a thin wrapper: read the upload into the same
 * draft the preview builds, then hand it to `commitBankDraft` so the two
 * paths share one check and one commit.
 */
export const commitBankStatementUpload = async (userId: string, form: FormData) => {
  const { file, accountId } = readUpload(form);
  // Checked here too, and not just inside commitBankDraft below: failing fast
  // on an account the caller cannot use must not first read the file, which
  // for a PDF means asking the model to read it.
  await assertAccountOwned(userId, accountId);
  await assertBankAccount(accountId);

  const bytes = await file.arrayBuffer();
  const { draft } = await readStatement(bytes, userId);
  const sha256 = createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
  return commitBankDraft(userId, { accountId, filename: file.name, sha256, draft });
};

/**
 * Reconciles an account to a balance read off the bank. A statement reaches back
 * a year or two, so the ledger is short by whatever came before it: this takes
 * today's figure and writes the opening balance that closes the gap. Run again,
 * a difference of zero means every imported row still adds up.
 */
export const setAccountBalance = async (userId: string, body: z.infer<typeof BalanceInput>) => {
  const { accountId, on, balance } = BalanceInput.parse(body);
  await assertAccountOwned(userId, accountId);

  const stated = parseMoney(balance, EUR);
  const { txns } = await loadPortfolio(db, userId);
  const ownRows = txns.filter((txn) => txn.accountId === accountId);

  const existingOpening = await db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.accountId, accountId),
        eq(transactions.type, "OPENING_BALANCE"),
        eq(transactions.currency, EUR),
      ),
    )
    .get();

  // Derived without the current opening balance, so re-running this replaces it
  // rather than stacking a correction on top of a correction.
  const withoutOpening = ownRows.filter((txn) => txn.type !== "OPENING_BALANCE");
  const derived =
    cashBalancesAt(withoutOpening, on).find((entry) => entry.currency === EUR)?.amount ??
    zeroMoney(EUR);
  const opening = subMoney(stated, derived);

  // The day before the account's first recorded movement: the balance belongs
  // to the period the statements do not cover, not inside it.
  const firstRow = await db
    .select({ tradeDate: transactions.tradeDate })
    .from(transactions)
    .where(eq(transactions.accountId, accountId))
    .orderBy(asc(transactions.tradeDate))
    .get();
  const openingDate = dayBefore(firstRow?.tradeDate ?? on);

  // Recorded even at zero: the row carries the date the account's known
  // history starts from.
  const replacement = db.insert(transactions).values({
    accountId,
    instrumentId: null,
    type: "OPENING_BALANCE",
    tradeDate: openingDate,
    quantity: 0,
    unitPrice: null,
    amount: Number(opening.minor),
    fee: 0,
    tax: 0,
    currency: EUR,
    fxRateEur: 100_000_000,
    contentHash: `opening:${accountId}:EUR`,
    note: `Alkusaldo, johdettu saldosta ${formatMoney(stated)} (${on})`,
  });

  // One batch, which D1 runs as a single transaction: the delete must not land
  // without the insert that replaces it.
  await (existingOpening
    ? db.batch([
        db.delete(transactions).where(eq(transactions.id, existingOpening.id)),
        replacement,
      ])
    : db.batch([replacement]));

  return {
    on,
    statedEur: formatMoney(stated),
    derivedFromRowsEur: formatMoney(derived),
    openingBalanceEur: formatMoney(opening),
    openingBalanceDate: openingDate,
  };
};

import { env } from "cloudflare:workers";
import { createHash } from "node:crypto";
import { readUpload } from "./upload.ts";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";

import { cashBalancesAt } from "../../core/cash.ts";
import { EUR, formatMoney, parseMoney, subMoney, zeroMoney } from "../../core/money.ts";
import { assertAccountOwned } from "../accounts.ts";
import { commitBankStatement } from "./bank-commit.ts";
import { matchesBank, OP_BANK, OP_CREDIT, parseBankStatement } from "./bank-statement.ts";
import type { BankRow, BankStatementConfig } from "./bank-statement.ts";
import {
  extractStatementText,
  parseOpStatementText,
  verifyStatement,
  type PdfStatement,
} from "./bank-pdf.ts";
import { isSweepStatement, parseSweepStatementText } from "./bank-pdf-sweep.ts";
import { type Db, db } from "../db/index.ts";
import { accounts, transactions } from "../db/schema.ts";
import { HttpError } from "../errors.ts";
import { loadPortfolio } from "../valuation.ts";
import { CHAT_MODEL, createClient, type ToolRunnerClient } from "../chat/runner.ts";
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
 * Reads whichever format arrived. A PDF carries the balances the CSV leaves out
 * and is checked against them: the rows must account for the difference or the
 * file is refused, which is what makes the more fragile format the safer import.
 */
const readStatement = async (
  bytes: ArrayBuffer,
): Promise<{
  bank: string;
  rows: BankRow[];
  problems: Array<{ line: number; message: string }>;
  statement: PdfStatement | null;
}> => {
  if (!isPdf(bytes)) {
    const config = detect(bytes);
    const { rows, problems } = parseBankStatement(bytes, config);
    return { bank: config.bank, rows, problems, statement: null };
  }

  const text = await extractStatementText(bytes).catch((cause: unknown) => {
    throw asBadRequest(cause);
  });
  // Which bank's PDF this is, decided from the document's own words rather than
  // from the file name: a statement saved as "tiliote.pdf" is still whatever the
  // bank wrote inside it.
  const sweep = isSweepStatement(text);
  let statement: PdfStatement;
  try {
    statement = sweep ? parseSweepStatementText(text) : parseOpStatementText(text);
  } catch (cause) {
    // A PDF this parser cannot read is the caller's problem to act on -- a
    // statement from another bank, a different report saved as a statement --
    // so it must arrive as the message that says so. Left as a thrown Error it
    // became a generic 500 "Palvelinvirhe", which tells the owner nothing about
    // what to do next.
    throw asBadRequest(cause);
  }
  const check = verifyStatement(statement);
  if (!check.ok) {
    const difference = formatMoney({ minor: check.differenceEur, currency: EUR });
    throw new HttpError(
      400,
      `Tiliotteen rivit eivät täsmää sen omaan loppusaldoon (ero ${difference} €). ` +
        "Tiedostoa ei tuotu, koska osa riveistä on ilmeisesti luettu väärin.",
    );
  }
  return {
    bank: sweep ? "sweepbank" : "op",
    rows: statement.rows,
    problems: statement.problems,
    statement,
  };
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
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const { txns } = await loadPortfolio(db, userId);
  return classifyNewMerchants(db, userId, {
    txns,
    accountIds: new Set([accountId]),
    client: classifierClient ?? createClient(apiKey),
    model: CHAT_MODEL,
  });
};

/** Injected by tests, so classification never reaches the real API. */
let classifierClient: ToolRunnerClient | null = null;
export const _setClassifierClient = (client: ToolRunnerClient | null): void => {
  classifierClient = client;
};

type MaturityOutcome = {
  /** What the account carries after this import. */
  readonly maturityDate: string | null;
  /** The statement's date when it disagrees with the account's own; null otherwise. */
  readonly maturityConflict: string | null;
};

const recordMaturity = async (
  db: Db,
  accountId: number,
  statement: PdfStatement,
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
  statement: PdfStatement,
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
  const { bank, rows, problems, statement } = await readStatement(bytes);

  const totalIn = rows.filter((row) => row.amount > 0n).reduce((sum, row) => sum + row.amount, 0n);
  const totalOut = rows.filter((row) => row.amount < 0n).reduce((sum, row) => sum + row.amount, 0n);

  return {
    bank,
    rows: rows.length,
    from: rows[0]?.date ?? null,
    to: rows.at(-1)?.date ?? null,
    totalInEur: formatMoney({ minor: totalIn, currency: EUR }),
    totalOutEur: formatMoney({ minor: totalOut, currency: EUR }),
    // Present only for a PDF: the balances the statement itself prints, and the
    // fact that the rows were checked against them.
    openingBalanceEur: statement === null ? null : formatMoney(statement.openingBalance),
    closingBalanceEur: statement === null ? null : formatMoney(statement.closingBalance),
    // A fixed-term deposit's statement prints when it comes free. Shown so the
    // owner can put it on the account; not written here, since changing an
    // account's terms is not something reading a file should do.
    maturityDate: statement?.maturityDate ?? null,
    verified: statement !== null,
    problems,
    // The first rows only, so the owner can see the parse is right before
    // committing several hundred of them.
    sample: rows.slice(0, 10).map((row) => ({
      date: row.date,
      type: row.type,
      amountEur: formatMoney({ minor: row.amount, currency: EUR }),
      note: row.note,
    })),
  };
};

export const commitBankStatementUpload = async (userId: string, form: FormData) => {
  const { file, accountId } = readUpload(form);
  await assertAccountOwned(userId, accountId);
  await assertBankAccount(accountId);

  const bytes = await file.arrayBuffer();
  const { rows, problems, statement } = await readStatement(bytes);
  if (rows.length === 0) throw new HttpError(400, "Tiedostosta ei löytynyt yhtään tapahtumaa");

  const sha256 = createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
  const result = await commitBankStatement(db, {
    userId,
    accountId,
    filename: file.name,
    sha256,
    rows,
  });

  // A PDF states what the account held before its first row, so the opening
  // balance is written from the statement instead of being asked for. The
  // ledger's own balance is then compared against the printed closing one: they
  // agree unless this account already held rows for the same period.
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
    problems,
    reconciliation,
    classified,
    maturityDate: maturity?.maturityDate ?? null,
    maturityConflict: maturity?.maturityConflict ?? null,
  };
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

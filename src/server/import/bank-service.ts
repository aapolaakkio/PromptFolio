import { isPdf } from "./pdf-read.ts";
import { createHash } from "node:crypto";
import { readUpload } from "./upload.ts";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";

import { cashBalancesAt } from "../../core/cash.ts";
import { EUR, formatMoney, parseMoney, subMoney, zeroMoney, type Money } from "../../core/money.ts";
import { assertAccountOwned } from "../accounts.ts";
import { commitBankStatement } from "./bank-commit.ts";
import {
  BankDraft,
  bankDraftFromRows,
  bankDraftFromStatement,
  bankRowsFromDraft,
  checkBankDraft,
} from "./bank-draft.ts";
import { readBankCsvByRecipe } from "./recipe/csv-recipe.ts";
import { readBankPdfByRecipe } from "./recipe/read.ts";
import { unclaimedWorthReporting } from "./recipe/verify.ts";
import { type Db, db } from "../db/index.ts";
import { accounts, transactions } from "../db/schema.ts";
import { HttpError } from "../errors.ts";
import { loadPortfolio } from "../valuation.ts";
import { DEFAULT_CHAT_MODEL } from "../chat/models.ts";
import { createClient, type ChatClient } from "../chat/runner.ts";
import { withModelTimeout } from "../instruments/find-page.ts";
import { suggestRows } from "./suggest-rows.ts";
import { classifyNewMerchants, type ClassifyResult } from "../spending/classify.ts";

const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in the format YYYY-MM-DD");

const asBadRequest = (cause: unknown): HttpError =>
  new HttpError(
    400,
    cause instanceof Error ? cause.message : "The bank statement could not be read",
  );

const readStatement = async (
  bytes: ArrayBuffer,
  userId: string,
): Promise<{ bank: string; draft: BankDraft }> => {
  if (!isPdf(bytes)) {
    try {
      const { rows, problems } = await readBankCsvByRecipe(
        bytes,
        userId,
        readerClient ?? createClient(),
      );
      return { bank: "csv", draft: bankDraftFromRows(rows, problems) };
    } catch (cause) {
      throw cause instanceof HttpError ? cause : asBadRequest(cause);
    }
  }
  try {
    const run = await readBankPdfByRecipe(bytes, userId, readerClient ?? createClient());
    return {
      bank: "pdf",
      draft: bankDraftFromStatement(run.statement, unclaimedWorthReporting(run)),
    };
  } catch (cause) {
    throw asBadRequest(cause);
  }
};

let readerClient: ChatClient | null = null;
export const _setReaderClient = (client: ChatClient | null): void => {
  readerClient = client;
};

/** A statement belongs on a bank account: card payments on a brokerage account would pollute its returns. */
const assertBankAccount = async (accountId: number): Promise<void> => {
  const account = await db.select().from(accounts).where(eq(accounts.id, accountId)).get();
  if (account?.kind !== "bank") {
    throw new HttpError(400, "A bank statement can only be imported to a bank account");
  }
};

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

let classifierClient: ChatClient | null = null;
export const _setClassifierClient = (client: ChatClient | null): void => {
  classifierClient = client;
};

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
  readonly maturityDate: string | null;
  readonly maturityConflict: string | null;
};

/** a differing existing date is reported, not overwritten */
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
  readonly openingBalanceWritten: boolean;
  readonly openingBalanceDate: string;
};

/** They agree unless the account already held rows for the period (CSV and PDF archive ids differ). */
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

  // Overwriting on every import would count an earlier period money twice.
  const reachesFurtherBack = existing === undefined || statement.from < existing.tradeDate;

  if (reachesFurtherBack) {
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
      note: `Opening balance from the statement of ${statement.from}`,
    });

    // One batch (a single D1 transaction): the delete must not land without the insert.
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

const dayBefore = (date: string): string => {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() - 1);
  return parsed.toISOString().slice(0, 10);
};

export const BalanceInput = z
  .object({
    accountId: z.number().int().positive(),
    on: IsoDateSchema,
    balance: z.string().regex(/^-?\d+([.,]\d{1,2})?$/, "Balance in the format 1234.56"),
  })
  .strict();

const EXAMPLE_ROWS = 5;

/** The model proposes values for rows the recipe could not read; the page shows them as unconfirmed. */
const withSuggestions = async (draft: BankDraft): Promise<BankDraft> => {
  if (draft.problems.length === 0) return draft;
  let client: ChatClient;
  try {
    client = withModelTimeout(readerClient ?? createClient());
  } catch {
    return draft;
  }
  const found = await suggestRows(
    client,
    "bank",
    draft.problems.map((problem) => ({
      line: problem.line,
      raw: problem.raw ?? problem.text,
      message: problem.text,
    })),
    draft.rows.slice(0, EXAMPLE_ROWS).map((row) => ({
      date: row.date,
      type: row.type,
      amountEur: row.amountEur,
      counterparty: row.counterparty,
    })),
  );
  return {
    ...draft,
    problems: draft.problems.map((problem) => {
      const suggestion = found.get(problem.line);
      return suggestion === undefined ? problem : { ...problem, suggestion };
    }),
  };
};

export const previewBankStatement = async (userId: string, form: FormData) => {
  const { file, accountId } = readUpload(form);
  await assertAccountOwned(userId, accountId);
  await assertBankAccount(accountId);

  const bytes = await file.arrayBuffer();
  const read = await readStatement(bytes, userId);
  const { bank } = read;
  const draft = await withSuggestions(read.draft);
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

export const commitBankDraft = async (userId: string, body: z.infer<typeof CommitBankDraft>) => {
  const { accountId, filename, sha256, draft } = CommitBankDraft.parse(body);
  await assertAccountOwned(userId, accountId);
  await assertBankAccount(accountId);
  if (draft.rows.length === 0) throw new HttpError(400, "No transactions found in the file");

  const check = checkBankDraft(draft);
  if (check !== null && !check.ok) {
    throw new HttpError(
      400,
      `The statement's rows do not add up to its own closing balance (difference ${check.differenceEur} €). ` +
        "Fix the rows in the preview before importing.",
    );
  }

  const rows = bankRowsFromDraft(draft);
  const result = await commitBankStatement(db, { userId, accountId, filename, sha256, rows });

  const statement = draft.statement === null ? null : statementOf(draft.statement);
  const reconciliation =
    statement === null ? null : await reconcileToStatement(db, accountId, statement);
  const maturity = statement === null ? null : await recordMaturity(db, accountId, statement);

  const classified = await classifyImportedSpending(db, userId, accountId);

  return {
    ...result,
    problems: draft.problems.map((problem) => ({ line: problem.line, message: problem.text })),
    reconciliation,
    classified,
    maturityDate: maturity?.maturityDate ?? null,
    maturityConflict: maturity?.maturityConflict ?? null,
  };
};

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

  const withoutOpening = ownRows.filter((txn) => txn.type !== "OPENING_BALANCE");
  const derived =
    cashBalancesAt(withoutOpening, on).find((entry) => entry.currency === EUR)?.amount ??
    zeroMoney(EUR);
  const opening = subMoney(stated, derived);

  const firstRow = await db
    .select({ tradeDate: transactions.tradeDate })
    .from(transactions)
    .where(eq(transactions.accountId, accountId))
    .orderBy(asc(transactions.tradeDate))
    .get();
  const openingDate = dayBefore(firstRow?.tradeDate ?? on);

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
    note: `Opening balance, derived from balance ${formatMoney(stated)} (${on})`,
  });

  // One batch: the delete must not land without its replacement.
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

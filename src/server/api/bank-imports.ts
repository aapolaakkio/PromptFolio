import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";

import { cashBalancesAt } from "../../core/cash";
import { EUR, formatMoney, parseMoney, subMoney, zeroMoney } from "../../core/money";
import { assertAccountOwned } from "./accounts";
import { requireUser } from "../auth-guard";
import { commitBankStatement } from "../import/bank-commit";
import { matchesBank, OP_BANK, parseBankStatement } from "../import/bank-statement";
import type { BankRow, BankStatementConfig } from "../import/bank-statement";
import {
  extractStatementText,
  parseOpStatementText,
  verifyStatement,
  type PdfStatement,
} from "../import/bank-pdf";
import { isSweepStatement, parseSweepStatementText } from "../import/bank-pdf-sweep";
import { getDb } from "../db";
import { accounts, transactions } from "../db/schema";
import { HttpError, handle, json } from "../http";
import { loadPortfolio } from "../valuation";

type Db = ReturnType<typeof getDb>["db"];

const { db } = getDb();

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/** Every bank format the app can read. A file is matched against each in turn. */
const BANK_CONFIGS: readonly BankStatementConfig[] = [OP_BANK];

const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Päivämäärän on oltava muotoa YYYY-MM-DD");

const readUpload = async (request: Request): Promise<{ file: File; accountId: number }> => {
  const form = await request.formData();
  const file = form.get("file");
  const accountIdRaw = form.get("accountId");
  if (!(file instanceof File)) throw new HttpError(400, "Tiedosto puuttuu");
  if (file.size > MAX_UPLOAD_BYTES) throw new HttpError(413, "Tiedosto on liian suuri (max 5 MB)");
  if (accountIdRaw === null || accountIdRaw instanceof File) {
    throw new HttpError(400, "Tili puuttuu");
  }
  const accountId = Number(accountIdRaw);
  if (!Number.isInteger(accountId)) throw new HttpError(400, "Tili on virheellinen");
  return { file, accountId };
};

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
 * Reads whichever format arrived.
 *
 * A PDF carries the balances the CSV export leaves out, so it is checked
 * against them: the parsed rows must account for the difference between the
 * printed opening and closing balance, or the file is refused. Reading a PDF's
 * layout is the more fragile of the two, and this is what makes it the safer
 * import anyway -- a mis-parse cannot pass quietly.
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
 * A statement belongs on a bank account and nowhere else.
 *
 * Loading a year of card payments onto a brokerage account would put spending
 * into the ledger that the return figures are computed from -- exactly the
 * failure the bank/brokerage split exists to prevent (see valuation.ts's
 * `Portfolio.investedTxns`).
 */
const assertBankAccount = (accountId: number): void => {
  const account = db.select().from(accounts).where(eq(accounts.id, accountId)).get();
  if (account?.kind !== "bank") {
    throw new HttpError(400, "Tiliote voidaan tuoda vain pankkitilille");
  }
};

/**
 * Writes the opening balance a PDF statement states, then reports whether the
 * account's own ledger now matches the closing balance it prints.
 *
 * The second half is the part worth having. After importing a statement the two
 * figures agree by construction -- unless the account already held rows for the
 * same period, which is what happens when the same month is imported once as a
 * CSV and once as a PDF. Their archive ids differ between OP's two formats, so
 * nothing else would catch it, and the balance would quietly come out twice
 * what the bank says.
 */
type Reconciliation = {
  readonly statedClosingEur: string;
  readonly ledgerClosingEur: string;
  readonly differenceEur: string;
};

const reconcileToStatement = (
  db: Db,
  accountId: number,
  statement: PdfStatement,
): Reconciliation => {
  const existing = db
    .select({ id: transactions.id })
    .from(transactions)
    .where(
      and(
        eq(transactions.accountId, accountId),
        eq(transactions.type, "OPENING_BALANCE"),
        eq(transactions.currency, EUR),
      ),
    )
    .get();

  db.transaction((tx) => {
    if (existing) tx.delete(transactions).where(eq(transactions.id, existing.id)).run();
    if (statement.openingBalance.minor === 0n) return;
    tx.insert(transactions)
      .values({
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
      })
      .run();
  });

  const rows = db
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
  };
};

export const bankImportRoutes = {
  "/api/imports/bank/preview": {
    POST: handle(async (request) => {
      const { userId } = await requireUser(request);
      const { file, accountId } = await readUpload(request);
      assertAccountOwned(userId, accountId);
      assertBankAccount(accountId);

      const bytes = await file.arrayBuffer();
      const { bank, rows, problems, statement } = await readStatement(bytes);

      const totalIn = rows
        .filter((row) => row.amount > 0n)
        .reduce((sum, row) => sum + row.amount, 0n);
      const totalOut = rows
        .filter((row) => row.amount < 0n)
        .reduce((sum, row) => sum + row.amount, 0n);

      return json({
        bank,
        rows: rows.length,
        from: rows[0]?.date ?? null,
        to: rows.at(-1)?.date ?? null,
        totalInEur: formatMoney({ minor: totalIn, currency: EUR }),
        totalOutEur: formatMoney({ minor: totalOut, currency: EUR }),
        // Present only for a PDF: the balances the statement itself prints, and
        // the fact that the rows were checked against them.
        openingBalanceEur: statement === null ? null : formatMoney(statement.openingBalance),
        closingBalanceEur: statement === null ? null : formatMoney(statement.closingBalance),
        verified: statement !== null,
        problems,
        // A preview of what will be written, not the whole file: the browser
        // shows the first rows so the owner can see the parse is right before
        // committing several hundred of them.
        sample: rows.slice(0, 10).map((row) => ({
          date: row.date,
          type: row.type,
          amountEur: formatMoney({ minor: row.amount, currency: EUR }),
          note: row.note,
        })),
      });
    }),
  },

  "/api/imports/bank/commit": {
    POST: handle(async (request) => {
      const { userId } = await requireUser(request);
      const { file, accountId } = await readUpload(request);
      assertAccountOwned(userId, accountId);
      assertBankAccount(accountId);

      const bytes = await file.arrayBuffer();
      const { rows, problems, statement } = await readStatement(bytes);
      if (rows.length === 0) throw new HttpError(400, "Tiedostosta ei löytynyt yhtään tapahtumaa");

      const sha256 = new Bun.CryptoHasher("sha256").update(new Uint8Array(bytes)).digest("hex");
      const result = commitBankStatement(db, {
        userId,
        accountId,
        filename: file.name,
        sha256,
        rows,
      });

      // A PDF states what the account held before its first row, so the opening
      // balance is written from the statement instead of being asked for. The
      // ledger's own balance is then compared against the printed closing one:
      // they agree unless this account already held rows for the same period --
      // the same statement imported twice in two formats, say -- which is
      // exactly the case a person cannot spot by eye.
      const reconciliation =
        statement === null ? null : reconcileToStatement(db, accountId, statement);

      // Problems travel with the result rather than blocking it: a statement
      // whose 700th row is malformed should still import the other 699, and the
      // owner needs to know which one was left out.
      return json({ ...result, problems, reconciliation }, 201);
    }),
  },

  "/api/accounts/:id/balance": {
    /**
     * Reconciles an account to a balance the owner read off their bank.
     *
     * A statement reaches back a year or two, so the ledger's own sum is short
     * by whatever the account held before it starts. Rather than asking for a
     * balance from years ago that nobody can look up, this takes today's --
     * which is on screen in the bank's app -- and writes the OPENING_BALANCE
     * that makes the ledger agree with it.
     *
     * It is also a check, not just a convenience: run it again later and a
     * difference of zero means every imported row still adds up to what the
     * bank says. A difference that appears out of nowhere means an import went
     * wrong, and the owner finds out instead of trusting a quiet wrong number.
     */
    POST: handle(async (request) => {
      const { userId } = await requireUser(request);
      const accountId = z.coerce
        .number()
        .int()
        .positive()
        .parse(new URL(request.url).pathname.split("/").at(-2));
      assertAccountOwned(userId, accountId);

      const body = z
        .object({
          on: IsoDateSchema,
          balance: z.string().regex(/^-?\d+([.,]\d{1,2})?$/, "Saldo muodossa 1234.56"),
        })
        .strict()
        .parse(await request.json());

      const stated = parseMoney(body.balance, EUR);
      const { txns } = loadPortfolio(db, userId);
      const ownRows = txns.filter((txn) => txn.accountId === accountId);

      const existingOpening = db
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

      // Derived without the current opening balance, so re-running this
      // replaces it rather than stacking a correction on top of a correction.
      const withoutOpening = ownRows.filter((txn) => txn.type !== "OPENING_BALANCE");
      const derived =
        cashBalancesAt(withoutOpening, body.on).find((balance) => balance.currency === EUR)
          ?.amount ?? zeroMoney(EUR);
      const opening = subMoney(stated, derived);

      // The day before the account's first recorded movement: the balance
      // belongs to the period the statements do not cover, not inside it.
      const firstRow = db
        .select({ tradeDate: transactions.tradeDate })
        .from(transactions)
        .where(eq(transactions.accountId, accountId))
        .orderBy(asc(transactions.tradeDate))
        .get();
      const openingDate = dayBefore(firstRow?.tradeDate ?? body.on);

      db.transaction((tx) => {
        if (existingOpening) {
          tx.delete(transactions).where(eq(transactions.id, existingOpening.id)).run();
        }
        if (opening.minor === 0n) return;
        tx.insert(transactions)
          .values({
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
            note: `Alkusaldo, johdettu saldosta ${formatMoney(stated)} (${body.on})`,
          })
          .run();
      });

      return json({
        on: body.on,
        statedEur: formatMoney(stated),
        derivedFromRowsEur: formatMoney(derived),
        openingBalanceEur: formatMoney(opening),
        openingBalanceDate: openingDate,
      });
    }),
  },
};

/** The calendar day before `date`, in ISO form. */
const dayBefore = (date: string): string => {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() - 1);
  return parsed.toISOString().slice(0, 10);
};

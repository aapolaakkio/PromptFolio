import { createHash } from "node:crypto";
import { HttpError } from "./errors.ts";
import { and, desc, eq } from "drizzle-orm";
import type { z } from "zod";

import { EUR, parseMoney } from "../core/money.ts";
import { assertAccountOwned } from "./accounts.ts";
import { CashEntry } from "./action-inputs.ts";
import { db } from "./db/index.ts";
import { accounts, transactions } from "./db/schema.ts";
import { fxRateOn } from "./fx.ts";

/** The sign comes from the type, not the caller: a signed amount would make "-100" mean two things depending on the type. */
const signedMinor = (type: z.infer<typeof CashEntry>["type"], amount: bigint): bigint =>
  type === "WITHDRAWAL" ? -amount : amount;

/** Every manual row on one account: what a person typed, never an import's. */
export const listCashEntries = async (userId: string, accountId: number) => {
  await assertAccountOwned(userId, accountId);

  const rows = await db
    .select({
      id: transactions.id,
      type: transactions.type,
      tradeDate: transactions.tradeDate,
      amount: transactions.amount,
      currency: transactions.currency,
      note: transactions.note,
      importId: transactions.importId,
    })
    .from(transactions)
    .where(eq(transactions.accountId, accountId))
    .orderBy(desc(transactions.tradeDate), desc(transactions.id))
    .all();

  return {
    entries: rows
      // Hand-written rows only: an imported row is the broker's record and must not be editable.
      .filter((row) => row.importId === null && row.type !== "BUY" && row.type !== "SELL")
      .map((row) => ({
        id: row.id,
        type: row.type,
        tradeDate: row.tradeDate,
        amount: (Number(row.amount) / 100).toFixed(2),
        currency: row.currency,
        note: row.note,
      })),
  };
};

/** Records one manual movement, refusing a second opening balance per currency. */
export const addCashEntry = async (userId: string, body: z.infer<typeof CashEntry>) => {
  await assertAccountOwned(userId, body.accountId);

  const minor = signedMinor(body.type, parseMoney(body.amount, body.currency).minor);

  // One opening balance per account and currency: a second would silently double the starting money. Correct one by deleting it.
  if (body.type === "OPENING_BALANCE") {
    const existing = await db
      .select({ id: transactions.id })
      .from(transactions)
      .where(
        and(
          eq(transactions.accountId, body.accountId),
          eq(transactions.type, "OPENING_BALANCE"),
          eq(transactions.currency, body.currency),
        ),
      )
      .get();
    if (existing) {
      throw new HttpError(
        409,
        `The account already has an opening balance in ${body.currency}. Remove it first.`,
      );
    }
  }

  // A non-EUR entry needs a rate for its own date, like an imported row; a marker rate would put a wrong number into every euro total.
  const fxRateEur =
    body.currency === EUR ? 100_000_000 : await fxRateOn(db, body.currency, body.tradeDate);
  if (fxRateEur === null) {
    throw new HttpError(400, `No exchange rate for ${body.currency} on ${body.tradeDate}`);
  }

  // Hashed like an imported row, so entering the same movement twice hits the unique index instead of doubling a balance.
  const contentHash = createHash("sha256")
    .update(["manual", body.accountId, body.type, body.tradeDate, minor, body.currency].join("|"))
    .digest("hex");

  const existing = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(
      and(eq(transactions.accountId, body.accountId), eq(transactions.contentHash, contentHash)),
    )
    .get();
  if (existing) throw new HttpError(409, "The same entry has already been recorded");

  const created = await db
    .insert(transactions)
    .values({
      accountId: body.accountId,
      instrumentId: null,
      type: body.type,
      tradeDate: body.tradeDate,
      quantity: 0,
      unitPrice: null,
      amount: Number(minor),
      fee: 0,
      tax: 0,
      currency: body.currency,
      fxRateEur,
      contentHash,
      note: body.note ?? null,
    })
    .returning()
    .get();
  if (created === undefined) throw new HttpError(500, "Saving the entry failed");

  return { id: created.id };
};

/** Removes a manual row, and only a manual one. */
export const removeCashEntry = async (userId: string, id: number) => {
  // Ownership through the account, and only rows this route could have written: deleting an imported one would desync the ledger from its file (undoing an import is a separate operation).
  const row = await db
    .select({ id: transactions.id, importId: transactions.importId })
    .from(transactions)
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .where(and(eq(transactions.id, id), eq(accounts.userId, userId)))
    .get();
  if (!row) throw new HttpError(404, "Entry not found");
  if (row.importId !== null) {
    throw new HttpError(400, "An imported entry cannot be deleted here");
  }

  await db.delete(transactions).where(eq(transactions.id, id)).run();
  return { ok: true };
};

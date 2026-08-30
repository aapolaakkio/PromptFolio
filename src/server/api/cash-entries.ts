import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { EUR, parseMoney } from "../../core/money.ts";
import { assertAccountOwned } from "./accounts.ts";
import { requireUser } from "../auth-guard.ts";
import { currencyField } from "./currency-field.ts";
import { getDb } from "../db/index.ts";
import { accounts, transactions } from "../db/schema.ts";
import { HttpError, handle, json } from "../http.ts";
import { fxRateOn } from "../fx.ts";

const { db } = getDb();

const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Päivämäärän on oltava muotoa YYYY-MM-DD");

/**
 * The only cash movements a person may write by hand.
 *
 * BUY and SELL are absent deliberately: a trade carries an instrument, a
 * quantity and a cost basis, and inventing one through this route would put a
 * position in the ledger that no broker record backs. Trades arrive through the
 * import pipeline, which is the app's one source for them.
 *
 * These are what an account produces when no export covers it: money in, money
 * out, interest paid, and the balance it already held when its recorded history
 * begins. A bank statement reaches back a year or two, not to the account's
 * opening, so without that last one every balance derived from it is short by
 * whatever came before -- silently.
 */
const CashEntry = z
  .object({
    accountId: z.number().int().positive(),
    type: z.enum(["OPENING_BALANCE", "DEPOSIT", "WITHDRAWAL", "INTEREST"]),
    tradeDate: IsoDateSchema,
    /** A decimal string, never a JSON number -- the wire rule money follows everywhere. */
    amount: z.string().regex(/^\d+([.,]\d{1,2})?$/, "Summa muodossa 1234.56"),
    currency: currencyField.default(EUR),
    note: z.string().trim().max(200).optional(),
  })
  .strict();

/**
 * The stored sign, derived from the type rather than taken from the caller.
 *
 * A withdrawal is money leaving, so it is stored negative; a deposit and an
 * interest payment are money arriving. Asking the caller for a signed amount
 * would make "-100" mean two different things depending on which type it was
 * paired with, and the ledger would carry whichever the form happened to send.
 */
const signedMinor = (type: z.infer<typeof CashEntry>["type"], amount: bigint): bigint =>
  type === "WITHDRAWAL" ? -amount : amount;

export const cashEntryRoutes = {
  "/api/cash-entries": {
    GET: handle(async (request) => {
      const { userId } = await requireUser(request);
      const accountId = z.coerce
        .number()
        .int()
        .positive()
        .parse(new URL(request.url).searchParams.get("accountId"));
      assertAccountOwned(userId, accountId);

      const rows = db
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

      return json({
        entries: rows
          // Only hand-written rows: an imported row is the broker's record and
          // must not be editable here, or the ledger would stop matching the
          // export it came from.
          .filter((row) => row.importId === null && row.type !== "BUY" && row.type !== "SELL")
          .map((row) => ({
            id: row.id,
            type: row.type,
            tradeDate: row.tradeDate,
            amount: (Number(row.amount) / 100).toFixed(2),
            currency: row.currency,
            note: row.note,
          })),
      });
    }),

    POST: handle(async (request) => {
      const { userId } = await requireUser(request);
      const body = CashEntry.parse(await request.json());
      assertAccountOwned(userId, body.accountId);

      const minor = signedMinor(body.type, parseMoney(body.amount, body.currency).minor);

      // One opening balance per account and currency. A second would not read
      // as a correction, it would silently double the money the account started
      // with -- and nothing downstream could tell that had happened. Correcting
      // one means deleting it and entering the right figure.
      if (body.type === "OPENING_BALANCE") {
        const existing = db
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
            `Tilillä on jo alkusaldo valuutassa ${body.currency}. Poista se ensin.`,
          );
        }
      }

      // A non-EUR entry needs a rate for its own date, exactly like an imported
      // row: without one the amount cannot be valued, and storing a marker rate
      // would put a wrong number into every euro total that reads it.
      const fxRateEur =
        body.currency === EUR ? 100_000_000 : fxRateOn(db, body.currency, body.tradeDate);
      if (fxRateEur === null) {
        throw new HttpError(
          400,
          `Valuuttakurssia ${body.currency} ei löydy päivälle ${body.tradeDate}`,
        );
      }

      // Hashed over the same material an imported row is, so entering the same
      // movement twice is refused by the ledger's own unique index rather than
      // silently doubling a balance.
      const contentHash = createHash("sha256")
        .update(
          ["manual", body.accountId, body.type, body.tradeDate, minor, body.currency].join("|"),
        )
        .digest("hex");

      const existing = db
        .select({ id: transactions.id })
        .from(transactions)
        .where(
          and(
            eq(transactions.accountId, body.accountId),
            eq(transactions.contentHash, contentHash),
          ),
        )
        .get();
      if (existing) throw new HttpError(409, "Sama tapahtuma on jo kirjattu");

      const created = db
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

      return json({ id: created.id }, 201);
    }),
  },

  "/api/cash-entries/:id": {
    DELETE: handle(async (request) => {
      const { userId } = await requireUser(request);
      const id = z.coerce
        .number()
        .int()
        .positive()
        .parse(new URL(request.url).pathname.split("/").at(-1));

      // Ownership through the account, and only ever a row this route could have
      // written: an imported transaction belongs to its broker's record, and
      // deleting one here would silently desynchronise the ledger from the file
      // it came from. Undoing an import is a separate, whole-import operation.
      const row = db
        .select({ id: transactions.id, importId: transactions.importId })
        .from(transactions)
        .innerJoin(accounts, eq(accounts.id, transactions.accountId))
        .where(and(eq(transactions.id, id), eq(accounts.userId, userId)))
        .get();
      if (!row) throw new HttpError(404, "Tapahtumaa ei löydy");
      if (row.importId !== null) {
        throw new HttpError(400, "Tuotua tapahtumaa ei voi poistaa täältä");
      }

      db.delete(transactions).where(eq(transactions.id, id)).run();
      return json({ ok: true });
    }),
  },
};

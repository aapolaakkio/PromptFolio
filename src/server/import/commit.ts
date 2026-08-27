import { and, desc, eq, gt, lte, sql } from "drizzle-orm";
import type { getDb } from "../db";
import { fxRates, imports, transactions } from "../db/schema";
import { HttpError } from "../errors";
import { contentHash, type Draft, type DraftTxn } from "./map";

export type ImportKind = "csv_nordnet" | "csv_op" | "pdf" | "vision" | "manual";

export type CommitResult = {
  readonly importId: number;
  readonly inserted: number;
  readonly skipped: number;
};
export type UndoResult = { readonly deleted: number };

/**
 * The shared handle's type, taken from `getDb()` (never `openDb()` at
 * module scope -- see src/server/db/index.ts) so a caller building `args`
 * for `commitDraft`/`undoImport` from a route module lines up with the
 * type this file expects. This is a type-only reference: it never calls
 * `getDb()` itself, so importing this module has no side effect.
 */
type Db = ReturnType<typeof getDb>["db"];

/**
 * The minimal query surface this file's transaction-scoped helpers
 * actually call. `Db` (the shared handle's own type, `SQLiteBunDatabase &
 * { $client: Database }`) is *not* the type `db.transaction()` hands its
 * callback -- that callback's `tx` is a `SQLiteAsyncTransaction`, which
 * extends the same base class `Db` does but has no `$client`, so `tx` is
 * not assignable to `Db` itself (confirmed by `tsc`; that mismatch is
 * exactly why the task brief reached for `tx as unknown as Db`). `tx` and
 * `Db` *do* share every query method's signature, inherited from that
 * common base, so picking only the methods actually used here --
 * `select`/`insert`/`update`/`delete` -- gives every helper a type that
 * both a real `Db` and a transaction handle satisfy structurally, with no
 * assertion anywhere in this file.
 */
type TxDb = Pick<Db, "select" | "insert" | "update" | "delete">;

type TxnType = (typeof transactions.$inferInsert)["type"];

/**
 * `DraftTxn.type` (Task 11) is a plain `string` -- mapRows reads it out of
 * a broker's free-text column and only the broker's own `typeMap` values
 * ever land there, so nothing upstream can guarantee it matches the
 * ledger's stricter `type` enum at the type level. Checked here, against
 * the schema's own `enumValues` (never a hand-duplicated list that could
 * drift from schema.ts), immediately before the value is trusted as
 * `TxnType`.
 */
const isTxnType = (value: string): value is TxnType =>
  transactions.type.enumValues.some((candidate) => candidate === value);

/** Newest fx_rates entry for `currency` on or before `date`, or null if none exists. */
const fxRateOn = (db: TxDb, currency: "USD", date: string): number | null => {
  const row = db
    .select()
    .from(fxRates)
    .where(and(eq(fxRates.currency, currency), lte(fxRates.date, date)))
    .orderBy(desc(fxRates.date))
    .limit(1)
    .get();
  return row?.rateEur ?? null;
};

/**
 * Resolves the fx rate to store for one draft row. EUR rows already carry
 * a real rate (100_000_000, i.e. 1.0) from mapRows. A non-EUR row's
 * `fxRateEur: 0` is Task 11's marker for "unresolved" -- it must never
 * reach the ledger as-is, so this either replaces it with a real rate
 * looked up on or before the row's trade date, or throws.
 */
const resolveFxRate = (tx: TxDb, row: DraftTxn): number => {
  if (row.currency === "EUR" || row.fxRateEur !== 0) return row.fxRateEur;
  const rate = fxRateOn(tx, row.currency, row.tradeDate);
  if (rate === null) {
    throw new HttpError(
      400,
      `Valuuttakurssia ${row.currency} ei löydy päivälle ${row.tradeDate} (rivi ${row.line})`,
    );
  }
  return rate;
};

/** True when a row with this external id or content hash already exists for the account. */
const isDuplicate = (tx: TxDb, accountId: number, row: DraftTxn, hash: string): boolean => {
  const duplicate = tx
    .select({ id: transactions.id })
    .from(transactions)
    .where(
      row.externalId
        ? and(eq(transactions.accountId, accountId), eq(transactions.externalId, row.externalId))
        : and(eq(transactions.accountId, accountId), eq(transactions.contentHash, hash)),
    )
    .get();
  return duplicate !== undefined;
};

/**
 * The value actually written to the `content_hash` column. For a row with
 * no external id (an OP-style export never has one), this is exactly
 * `contentHash(row)` -- Task 11's material-only hash -- since that value
 * is that row's only stable identity, and the schema's `(accountId,
 * content_hash)` unique index exists precisely to catch a re-import of it.
 *
 * For a row that *does* carry an external id, `(accountId, externalId)`
 * is already that row's authoritative identity (rule 2's dedupe order
 * checks externalId first and never falls through to contentHash for such
 * a row). Folding the external id into what gets stored here too avoids a
 * real collision on the schema's separate `(accountId, content_hash)`
 * unique index: two genuinely different transactions that happen to share
 * every material field -- e.g. two same-day, same-amount deposits with
 * distinct broker ids, which is exactly what a real Nordnet export can
 * contain -- would otherwise fail the insert with a raw SQLite constraint
 * error, even though neither the broker nor this file's own dedupe logic
 * considers them duplicates. `contentHash` itself (Task 11, tested to
 * ignore `externalId`) is left untouched; only the stored value differs.
 */
const storedContentHash = (row: DraftTxn, accountId: number): string => {
  const material = contentHash({ ...row, accountId });
  return row.externalId
    ? new Bun.CryptoHasher("sha256").update(`${material}|${row.externalId}`).digest("hex")
    : material;
};

/** Inserts one draft row, or reports it as a skip if it's a duplicate. Throws on an invalid row. */
const insertRow = (
  tx: TxDb,
  accountId: number,
  importId: number,
  row: DraftTxn,
): "inserted" | "skipped" => {
  if (!isTxnType(row.type)) {
    throw new HttpError(400, `Tuntematon tapahtumatyyppi: ${row.type} (rivi ${row.line})`);
  }
  const hash = storedContentHash(row, accountId);
  if (isDuplicate(tx, accountId, row, hash)) return "skipped";

  tx.insert(transactions)
    .values({
      accountId,
      instrumentId: row.instrumentId,
      type: row.type,
      tradeDate: row.tradeDate,
      quantity: row.quantity,
      unitPrice: row.unitPrice,
      amount: row.amount,
      fee: row.fee,
      tax: row.tax,
      currency: row.currency,
      fxRateEur: resolveFxRate(tx, row),
      externalId: row.externalId,
      contentHash: hash,
      importId,
    })
    .run();
  return "inserted";
};

/**
 * Commits a parsed import into the append-only ledger. Every insert (the
 * `imports` row and every `transactions` row) happens inside one SQLite
 * transaction: if any row fails -- an unresolved fx rate, an unknown
 * transaction type -- the thrown error propagates out of the
 * `db.transaction()` callback uncaught, which is what makes drizzle roll
 * the whole transaction back. Nothing in this function may catch that
 * error before it leaves the callback.
 */
export const commitDraft = (
  db: Db,
  args: {
    userId: string;
    accountId: number;
    kind: ImportKind;
    filename: string;
    sha256: string;
    draft: Draft;
  },
): CommitResult => {
  const { draft } = args;
  if (draft.unknownIsins.length > 0) {
    throw new HttpError(
      400,
      `Tuntemattomat arvopaperit on lisättävä ensin: ${draft.unknownIsins.map((u) => u.isin).join(", ")}`,
    );
  }

  let inserted = 0;
  let skipped = 0;
  let importId = 0;

  db.transaction((tx) => {
    const created = tx
      .insert(imports)
      .values({
        userId: args.userId,
        kind: args.kind,
        filename: args.filename,
        sha256: args.sha256,
        status: "committed",
        rowCount: draft.txns.length,
      })
      .returning()
      .get();
    importId = created.id;

    for (const row of draft.txns) {
      if (insertRow(tx, args.accountId, importId, row) === "inserted") inserted++;
      else skipped++;
    }
  });

  return { importId, inserted, skipped };
};

/**
 * True when some transaction dated after `row` still needs the units this
 * import introduced -- i.e. any other transaction on the same account and
 * instrument, dated later, that does not itself belong to this import.
 * Deliberately not narrowed to only SELL/TRANSFER_OUT rows: this is the
 * one place an under-approximation (allowing an undo that turns out to be
 * unsafe) is worse than an over-approximation (refusing an undo that
 * would, in fact, have been safe) -- the ledger is append-only, so a wrong
 * undo cannot be corrected the way a merely-annoying refusal can.
 */
const hasLaterDependent = (
  tx: TxDb,
  row: { accountId: number; instrumentId: number; tradeDate: string },
  importId: number,
): boolean => {
  const later = tx
    .select({ id: transactions.id })
    .from(transactions)
    .where(
      and(
        eq(transactions.accountId, row.accountId),
        eq(transactions.instrumentId, row.instrumentId),
        gt(transactions.tradeDate, row.tradeDate),
        // SQLite's IS NOT is a NULL-safe inequality: `x IS NOT y` is true
        // whenever x and y differ, including when one side is NULL --
        // verified directly against sqlite (see task-12-report.md) and
        // pinned down by the "no import id at all" test in
        // commit.test.ts. That is exactly "belongs to a different
        // import", including a manually entered row with a NULL importId.
        sql`${transactions.importId} IS NOT ${importId}`,
      ),
    )
    .get();
  return later !== undefined;
};

/**
 * Undoes a committed import: deletes exactly the transaction rows carrying
 * its `importId`, and only that import's own rows (the append-only ledger
 * is otherwise immutable). Refuses if any later transaction on the same
 * account/instrument might depend on the units this import introduced --
 * see `hasLaterDependent`. Scoped to `args.userId` so one user can never
 * undo another user's import, and refuses an import that has already been
 * undone.
 */
export const undoImport = (db: Db, args: { userId: string; importId: number }): UndoResult => {
  const record = db
    .select()
    .from(imports)
    .where(and(eq(imports.id, args.importId), eq(imports.userId, args.userId)))
    .get();
  if (!record) throw new HttpError(404, "Tuontia ei löydy");
  if (record.status === "undone") throw new HttpError(409, "Tuonti on jo peruttu");

  let deleted = 0;
  db.transaction((tx) => {
    const rows = tx
      .select()
      .from(transactions)
      .where(eq(transactions.importId, args.importId))
      .all();

    for (const row of rows) {
      if (row.instrumentId === null) continue;
      const dependency = {
        accountId: row.accountId,
        instrumentId: row.instrumentId,
        tradeDate: row.tradeDate,
      };
      if (hasLaterDependent(tx, dependency, args.importId)) {
        throw new HttpError(
          409,
          "Tuontia ei voi perua: myöhempi tapahtuma käyttää sen tuomia osuuksia",
        );
      }
    }

    deleted = rows.length;
    tx.delete(transactions).where(eq(transactions.importId, args.importId)).run();
    tx.update(imports).set({ status: "undone" }).where(eq(imports.id, args.importId)).run();
  });

  return { deleted };
};

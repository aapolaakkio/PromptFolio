import { createHash } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import { EUR, type Currency } from "../../core/money";
import type { getDb } from "../db";
import { imports, transactions } from "../db/schema";
import { HttpError } from "../errors";
import { ensureFxRate, fxRateOn } from "../fx";
import type { FetchImpl } from "../prices/types";
import { contentHash, type Draft, type DraftTxn } from "./map";

export type ImportKind = "csv_nordnet" | "csv_op" | "pdf" | "vision" | "manual";

export type CommitResult = {
  readonly importId: number;
  readonly inserted: number;
  readonly skipped: number;
  /**
   * Rows already stored that this import filled a blank field on -- today the
   * broker's own row text. Counted apart from `skipped` because a re-import
   * that corrected something is not the same event as one that did nothing,
   * and the import history should not describe it as nothing.
   */
  readonly enriched: number;
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

/**
 * Resolves the fx rate to store for one draft row. EUR rows already carry
 * a real rate (100_000_000, i.e. 1.0) from mapRows. A non-EUR row's
 * `fxRateEur: 0` is Task 11's marker for "unresolved" -- it must never
 * reach the ledger as-is, so this either replaces it with a real rate
 * looked up on or before the row's trade date, or throws.
 */
const resolveFxRate = (tx: TxDb, row: DraftTxn): number => {
  if (row.currency === EUR || row.fxRateEur !== 0) return row.fxRateEur;
  const rate = fxRateOn(tx, row.currency, row.tradeDate);
  if (rate === null) {
    throw new HttpError(
      400,
      `Valuuttakurssia ${row.currency} ei löydy päivälle ${row.tradeDate} (rivi ${row.line})`,
    );
  }
  return rate;
};

/** The already-stored row this draft row duplicates, if there is one. */
const existingRow = (
  tx: TxDb,
  accountId: number,
  row: DraftTxn,
  hash: string,
): { id: number; note: string | null } | undefined =>
  tx
    .select({ id: transactions.id, note: transactions.note })
    .from(transactions)
    .where(
      row.externalId
        ? and(eq(transactions.accountId, accountId), eq(transactions.externalId, row.externalId))
        : and(eq(transactions.accountId, accountId), eq(transactions.contentHash, hash)),
    )
    .get();

/**
 * Fills in a row's text when the ledger has none and this import does.
 *
 * The broker's text was not stored until it was needed to tell one kind of cash
 * movement from another, so every row imported before then has none -- and
 * because the text is not part of the content hash (rightly: the same
 * transaction is the same transaction whatever the export says about it), a
 * re-import skips those rows rather than correcting them. Without this, getting
 * the text would mean deleting and re-importing a whole history.
 *
 * Only a blank is filled. An existing text is never overwritten: two exports of
 * the same period can word a row differently, and the first one imported is no
 * less authoritative than the second.
 */
const enrichNote = (
  tx: TxDb,
  existing: { id: number; note: string | null },
  row: DraftTxn,
): boolean => {
  if (existing.note !== null || row.note === null) return false;
  tx.update(transactions).set({ note: row.note }).where(eq(transactions.id, existing.id)).run();
  return true;
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
    ? createHash("sha256").update(`${material}|${row.externalId}`).digest("hex")
    : material;
};

/** Inserts one draft row, or reports it as a skip if it's a duplicate. Throws on an invalid row. */
const insertRow = (
  tx: TxDb,
  accountId: number,
  importId: number,
  row: DraftTxn,
): "inserted" | "skipped" | "enriched" => {
  if (!isTxnType(row.type)) {
    throw new HttpError(400, `Tuntematon tapahtumatyyppi: ${row.type} (rivi ${row.line})`);
  }
  const hash = storedContentHash(row, accountId);
  const existing = existingRow(tx, accountId, row, hash);
  if (existing !== undefined) return enrichNote(tx, existing, row) ? "enriched" : "skipped";

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
      note: row.note,
      contentHash: hash,
      importId,
    })
    .run();
  return "inserted";
};

/**
 * Ensures every unresolved (non-EUR, `fxRateEur: 0`) currency in `draft` has at least a
 * chance to resolve before the real transaction opens, by attempting one on-demand ECB
 * fetch per currency still missing a rate (C1b -- see `fx.ts`'s `ensureFxRate`). Runs
 * *before* `db.transaction()` deliberately: the fetch is a network call, and drizzle's
 * `bun:sqlite` transaction callback is synchronous, so an `await` cannot live inside it.
 *
 * At most one fetch per distinct currency, no matter how many rows need it: `ensureFxRate`
 * always fetches the same thing (ECB's current daily file has no date parameter), so a
 * currency already attempted this call either just got a fresh rate (further rows recheck
 * it for free inside `resolveFxRate`) or genuinely can't be resolved today (retrying it
 * per-row would just repeat the same failed network call). Rows still unresolved after this
 * runs get the informative, unchanged `resolveFxRate` refusal message.
 */
const ensureDraftFxRates = async (db: Db, draft: Draft, fetchImpl: FetchImpl): Promise<void> => {
  const attempted = new Set<Currency>();
  for (const row of draft.txns) {
    if (row.currency === EUR || row.fxRateEur !== 0) continue;
    if (attempted.has(row.currency)) continue;
    attempted.add(row.currency);
    if (fxRateOn(db, row.currency, row.tradeDate) !== null) continue;
    await ensureFxRate(db, row.currency, row.tradeDate, fetchImpl);
  }
};

/**
 * Commits a parsed import into the append-only ledger. Every insert (the
 * `imports` row and every `transactions` row) happens inside one SQLite
 * transaction: if any row fails -- an unresolved fx rate, an unknown
 * transaction type -- the thrown error propagates out of the
 * `db.transaction()` callback uncaught, which is what makes drizzle roll
 * the whole transaction back. Nothing in this function may catch that
 * error before it leaves the callback.
 *
 * Async since C1b: `ensureDraftFxRates` above may need one on-demand network fetch per
 * unresolved currency before the (still fully synchronous) transaction opens.
 */
export const commitDraft = async (
  db: Db,
  args: {
    userId: string;
    accountId: number;
    kind: ImportKind;
    filename: string;
    sha256: string;
    draft: Draft;
    /** Injected in tests; defaults to the real `fetch` in production (C1b's on-demand ECB fetch). */
    fetchImpl?: FetchImpl;
  },
): Promise<CommitResult> => {
  const { draft } = args;
  if (draft.unknownIsins.length > 0) {
    // `isin` is null for a broker whose export carries no ISIN at all
    // (OP's web-paste view -- see brokers.ts). Falling back to `name`
    // there is required, not cosmetic: `Array.prototype.join` renders a
    // null entry as an empty string, so without this fallback every real
    // OP commit refusal would read as a bare ", " with nothing named.
    const label = (u: Draft["unknownIsins"][number]): string => u.isin ?? u.name;
    throw new HttpError(
      400,
      `Tuntemattomat arvopaperit on lisättävä ensin: ${draft.unknownIsins.map(label).join(", ")}`,
    );
  }

  await ensureDraftFxRates(db, draft, args.fetchImpl ?? fetch);

  let inserted = 0;
  let skipped = 0;
  let enriched = 0;
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
      const outcome = insertRow(tx, args.accountId, importId, row);
      if (outcome === "inserted") inserted++;
      else if (outcome === "enriched") enriched++;
      else skipped++;
    }

    // Written back onto the just-created row rather than known up front: `inserted`/
    // `skipped` are the *outcome* of the insert loop above (a duplicate content hash
    // or external id can only be detected by actually attempting each row), not
    // something derivable from `draft` alone before it runs. `/api/imports` (the
    // history listing) reads these back -- they cannot be recovered later from
    // `transactions` alone once an import is undone (its rows are deleted) or for a
    // skipped row (which was never inserted at all) -- see schema.ts's own comment.
    tx.update(imports)
      .set({ insertedCount: inserted, skippedCount: skipped })
      .where(eq(imports.id, importId))
      .run();
  });

  return { importId, inserted, skipped, enriched };
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

import { createHash } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import { EUR, type Currency } from "../../core/money.ts";
import type { Db } from "../db/index.ts";
import { imports, transactions } from "../db/schema.ts";
import { HttpError } from "../errors.ts";
import { ensureFxRate, fxRateOn } from "../fx.ts";
import type { FetchImpl } from "../prices/types.ts";
import { contentHash, type Draft, type DraftTxn } from "./map.ts";

export type ImportKind = "csv_nordnet" | "csv_op" | "csv" | "paste" | "pdf" | "vision" | "manual";

export type CommitResult = {
  readonly importId: number;
  readonly inserted: number;
  readonly skipped: number;
  /**
   * Stored rows this import filled a blank on. Counted apart from `skipped`: a
   * re-import that corrected something is not an import that did nothing.
   */
  readonly enriched: number;
};
export type UndoResult = { readonly deleted: number };

// Type-only, so importing this module never opens a database.

// A transaction callback's `tx` is not assignable to `Db`, but shares every
// query method, so picking the ones used here gives a type both satisfy --
// which is what keeps an assertion out of this file.
type TxDb = Pick<Db, "select" | "insert" | "update" | "delete">;

type TxnType = (typeof transactions.$inferInsert)["type"];

/** A draft's type comes out of a broker's free-text column, so it is checked
 * against the schema's own enum values rather than a list that could drift. */
const isTxnType = (value: string): value is TxnType =>
  transactions.type.enumValues.some((candidate) => candidate === value);

/**
 * The rate to store for one row. A non-EUR row arrives at zero, meaning
 * unresolved, which must never reach the ledger: this replaces it with a real
 * rate on or before the trade date, or throws.
 */
const resolveFxRate = async (tx: TxDb, row: DraftTxn): Promise<number> => {
  if (row.currency === EUR || row.fxRateEur !== 0) return row.fxRateEur;
  const rate = await fxRateOn(tx, row.currency, row.tradeDate);
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
): Promise<{ id: number; note: string | null } | undefined> =>
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
const enrichNote = async (
  tx: TxDb,
  existing: { id: number; note: string | null },
  row: DraftTxn,
): Promise<boolean> => {
  if (existing.note !== null || row.note === null) return false;
  await tx
    .update(transactions)
    .set({ note: row.note })
    .where(eq(transactions.id, existing.id))
    .run();
  return true;
};

/**
 * What goes in the `content_hash` column.
 *
 * Without an external id it is the material hash, which is the row's only stable
 * identity. With one, the id is folded in as well: two same-day, same-amount
 * deposits carrying distinct broker ids are genuinely different transactions,
 * and a real Nordnet export contains them -- sharing a hash they would fail the
 * unique index even though nothing here considers them duplicates.
 */
const storedContentHash = (row: DraftTxn, accountId: number): string => {
  const material = contentHash({ ...row, accountId });
  return row.externalId
    ? createHash("sha256").update(`${material}|${row.externalId}`).digest("hex")
    : material;
};

/** Inserts one draft row, or reports it as a skip if it's a duplicate. Throws on an invalid row. */
const insertRow = async (
  tx: TxDb,
  accountId: number,
  importId: number,
  row: DraftTxn,
  fxRateEur: number,
): Promise<"inserted" | "skipped" | "enriched"> => {
  if (!isTxnType(row.type)) {
    throw new HttpError(400, `Tuntematon tapahtumatyyppi: ${row.type} (rivi ${row.line})`);
  }
  const hash = storedContentHash(row, accountId);
  const existing = await existingRow(tx, accountId, row, hash);
  if (existing !== undefined) return (await enrichNote(tx, existing, row)) ? "enriched" : "skipped";

  await tx
    .insert(transactions)
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
      fxRateEur,
      externalId: row.externalId,
      note: row.note,
      contentHash: hash,
      importId,
    })
    .run();
  return "inserted";
};

/**
 * One ECB fetch per still-unresolved currency, before any row is written, so a
 * network call never sits between two of this import's inserts. One per
 * currency, not per row: the daily file takes no date, so a second attempt
 * would repeat the same call.
 */
const ensureDraftFxRates = async (db: Db, draft: Draft, fetchImpl: FetchImpl): Promise<void> => {
  const attempted = new Set<Currency>();
  for (const row of draft.txns) {
    if (row.currency === EUR || row.fxRateEur !== 0) continue;
    if (attempted.has(row.currency)) continue;
    attempted.add(row.currency);
    if ((await fxRateOn(db, row.currency, row.tradeDate)) !== null) continue;
    await ensureFxRate(db, row.currency, row.tradeDate, fetchImpl);
  }
};

/**
 * Commits a parsed import into the append-only ledger.
 *
 * The inserts are no longer one transaction -- see the loop below for why D1
 * cannot express this one -- so a row that fails leaves the rows before it
 * written. The import record is what makes that recoverable: undo it and
 * re-import. Nothing here may catch that error and carry on regardless.
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
    // Required, not cosmetic: `join` renders a null as an empty string, so
    // without the name every OP refusal would read as a bare ", ".
    const label = (u: Draft["unknownIsins"][number]): string => u.isin ?? u.name;
    throw new HttpError(
      400,
      `Tuntemattomat arvopaperit on lisättävä ensin: ${draft.unknownIsins.map(label).join(", ")}`,
    );
  }

  await ensureDraftFxRates(db, draft, args.fetchImpl ?? fetch);

  // Every refusal is decided before anything is written. A row can only fail
  // on an unknown type or a missing FX rate, and both are known up front, so a
  // rejected commit leaves the ledger untouched -- what the transaction this
  // replaced used to buy. D1 has no transaction to offer: it rejects BEGIN, and
  // `insertRow` reads before it writes with each row able to see the one
  // before it, which `db.batch` cannot express.
  const resolved: { row: DraftTxn; fxRateEur: number }[] = [];
  for (const row of draft.txns) {
    if (!isTxnType(row.type)) {
      throw new HttpError(400, `Tuntematon tapahtumatyyppi: ${row.type} (rivi ${row.line})`);
    }
    resolved.push({ row, fxRateEur: await resolveFxRate(db, row) });
  }

  let inserted = 0;
  let skipped = 0;
  let enriched = 0;

  const created = await db
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
  if (created === undefined) throw new HttpError(500, "Tuontitietueen luonti epäonnistui");
  const importId = created.id;

  // ponytail: each statement auto-commits, so a database error part-way leaves
  // an import whose stored counts are never written. Undo it and re-import.
  // Upgrade path: mark the record "pending" first and flip it to "committed"
  // in the final update, so a part-written import is identifiable.
  for (const { row, fxRateEur } of resolved) {
    const outcome = await insertRow(db, args.accountId, importId, row, fxRateEur);
    if (outcome === "inserted") inserted++;
    else if (outcome === "enriched") enriched++;
    else skipped++;
  }

  // The outcome of the loop above, not derivable from the draft: a duplicate is
  // only found by attempting the row. Stored because neither an undone import's
  // rows nor a skipped row survives to be counted later.
  await db
    .update(imports)
    .set({ insertedCount: inserted, skippedCount: skipped })
    .where(eq(imports.id, importId))
    .run();

  return { importId, inserted, skipped, enriched };
};

/**
 * Whether a later transaction still needs the units this import introduced.
 *
 * Not narrowed to disposals on purpose: the ledger is append-only, so an undo
 * that turns out to be unsafe cannot be corrected the way a refusal can.
 */
const hasLaterDependent = async (
  tx: TxDb,
  row: { accountId: number; instrumentId: number; tradeDate: string },
  importId: number,
): Promise<boolean> => {
  const later = await tx
    .select({ id: transactions.id })
    .from(transactions)
    .where(
      and(
        eq(transactions.accountId, row.accountId),
        eq(transactions.instrumentId, row.instrumentId),
        gt(transactions.tradeDate, row.tradeDate),
        // SQLite's IS NOT is NULL-safe, so this covers a manually entered row
        // whose import id is NULL.
        sql`${transactions.importId} IS NOT ${importId}`,
      ),
    )
    .get();
  return later !== undefined;
};

/**
 * Deletes exactly the rows one import wrote, and nothing else. Refuses when a
 * later transaction might depend on the units it introduced, when the import
 * belongs to another user, or when it has already been undone.
 */
export const undoImport = async (
  db: Db,
  args: { userId: string; importId: number },
): Promise<UndoResult> => {
  const record = await db
    .select()
    .from(imports)
    .where(and(eq(imports.id, args.importId), eq(imports.userId, args.userId)))
    .get();
  if (!record) throw new HttpError(404, "Tuontia ei löydy");
  if (record.status === "undone") throw new HttpError(409, "Tuonti on jo peruttu");

  const rows = await db
    .select()
    .from(transactions)
    .where(eq(transactions.importId, args.importId))
    .all();

  // Every refusal is decided before anything is written, so a rejected undo
  // still touches nothing -- which is what the old transaction bought here.
  for (const row of rows) {
    if (row.instrumentId === null) continue;
    const dependency = {
      accountId: row.accountId,
      instrumentId: row.instrumentId,
      tradeDate: row.tradeDate,
    };
    if (await hasLaterDependent(db, dependency, args.importId)) {
      throw new HttpError(
        409,
        "Tuontia ei voi perua: myöhempi tapahtuma käyttää sen tuomia osuuksia",
      );
    }
  }

  // One batch, which D1 runs as a single transaction: rows deleted without the
  // import being marked undone would leave an import that cannot be undone again.
  await db.batch([
    db.delete(transactions).where(eq(transactions.importId, args.importId)),
    db.update(imports).set({ status: "undone" }).where(eq(imports.id, args.importId)),
  ]);

  return { deleted: rows.length };
};

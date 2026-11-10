import { createHash } from "node:crypto";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { EUR, type Currency } from "../../core/money.ts";
import type { Db } from "../db/index.ts";
import { imports, transactions } from "../db/schema.ts";
import { HttpError } from "../errors.ts";
import { ensureFxRate, fxRateOn } from "../fx.ts";
import type { FetchImpl } from "../prices/types.ts";
import { contentHash, type Draft, type DraftTxn } from "./map.ts";

type ImportKind = "csv_nordnet" | "csv_op" | "csv" | "paste" | "pdf" | "vision" | "manual";

export type CommitResult = {
  readonly importId: number;
  readonly inserted: number;
  readonly skipped: number;
  readonly enriched: number;
};
type UndoResult = { readonly deleted: number };

// A transaction's `tx` is not assignable to `Db`, but shares these methods; picking them avoids a cast.
type TxDb = Pick<Db, "select" | "insert" | "update" | "delete">;

type TxnType = (typeof transactions.$inferInsert)["type"];

const isTxnType = (value: string): value is TxnType =>
  transactions.type.enumValues.some((candidate) => candidate === value);

/** A non-EUR row arrives at zero (unresolved); that must never reach the ledger. */
const resolveFxRate = async (tx: TxDb, row: DraftTxn): Promise<number> => {
  if (row.currency === EUR || row.fxRateEur !== 0) return row.fxRateEur;
  const rate = await fxRateOn(tx, row.currency, row.tradeDate);
  if (rate === null) {
    throw new HttpError(
      400,
      `No ${row.currency} exchange rate found for ${row.tradeDate} (line ${row.line})`,
    );
  }
  return rate;
};

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
        : and(
            eq(transactions.accountId, accountId),
            inArray(transactions.contentHash, [
              hash,
              storedContentHash({ ...row, isin: null }, accountId),
            ]),
          ),
    )
    .get();

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

/** The external id keeps same-day same-amount deposits apart on the unique index. */
const storedContentHash = (row: DraftTxn, accountId: number): string => {
  const material = contentHash({ ...row, accountId });
  return row.externalId
    ? createHash("sha256").update(`${material}|${row.externalId}`).digest("hex")
    : material;
};

const insertRow = async (
  tx: TxDb,
  accountId: number,
  importId: number,
  row: DraftTxn,
  fxRateEur: number,
): Promise<"inserted" | "skipped" | "enriched"> => {
  if (!isTxnType(row.type)) {
    throw new HttpError(400, `Unknown transaction type: ${row.type} (line ${row.line})`);
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

/** Inserts are not one transaction (D1 cannot): a failing row leaves earlier rows; undo and re-import. */
export const commitDraft = async (
  db: Db,
  args: {
    userId: string;
    accountId: number;
    kind: ImportKind;
    filename: string;
    sha256: string;
    draft: Draft;
    fetchImpl?: FetchImpl;
  },
): Promise<CommitResult> => {
  const { draft } = args;
  if (draft.unknownIsins.length > 0) {
    const label = (u: Draft["unknownIsins"][number]): string => u.isin ?? u.name;
    throw new HttpError(
      400,
      `Unknown instruments must be added first: ${draft.unknownIsins.map(label).join(", ")}`,
    );
  }

  await ensureDraftFxRates(db, draft, args.fetchImpl ?? fetch);

  // Every refusal is decided before anything is written; D1 rejects BEGIN and `db.batch` cannot express insertRow's read-then-write.
  const resolved: { row: DraftTxn; fxRateEur: number }[] = [];
  for (const row of draft.txns) {
    if (!isTxnType(row.type)) {
      throw new HttpError(400, `Unknown transaction type: ${row.type} (line ${row.line})`);
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
  if (created === undefined) throw new HttpError(500, "Creating the import record failed");
  const importId = created.id;

  // ponytail: statements auto-commit, so a mid-import error leaves no stored counts. Upgrade: mark pending first.
  for (const { row, fxRateEur } of resolved) {
    const outcome = await insertRow(db, args.accountId, importId, row, fxRateEur);
    if (outcome === "inserted") inserted++;
    else if (outcome === "enriched") enriched++;
    else skipped++;
  }

  await db
    .update(imports)
    .set({ insertedCount: inserted, skippedCount: skipped })
    .where(eq(imports.id, importId))
    .run();

  return { importId, inserted, skipped, enriched };
};

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
        // IS NOT is NULL-safe: covers manual rows with a NULL import id.
        sql`${transactions.importId} IS NOT ${importId}`,
      ),
    )
    .get();
  return later !== undefined;
};

export const undoImport = async (
  db: Db,
  args: { userId: string; importId: number; expectCount?: number | undefined },
): Promise<UndoResult> => {
  const record = await db
    .select()
    .from(imports)
    .where(and(eq(imports.id, args.importId), eq(imports.userId, args.userId)))
    .get();
  if (!record) throw new HttpError(404, "Import not found");
  if (record.status === "undone") throw new HttpError(409, "Import is already undone");

  const rows = await db
    .select()
    .from(transactions)
    .where(eq(transactions.importId, args.importId))
    .all();
  // A chat card said how many rows would go; a different count means it no longer describes this undo.
  if (args.expectCount !== undefined && args.expectCount !== rows.length) {
    throw new HttpError(409, "The import changed since the card was made. Ask again.");
  }

  for (const row of rows) {
    if (row.instrumentId === null) continue;
    const dependency = {
      accountId: row.accountId,
      instrumentId: row.instrumentId,
      tradeDate: row.tradeDate,
    };
    if (await hasLaterDependent(db, dependency, args.importId)) {
      throw new HttpError(409, "Cannot undo the import: a later transaction uses its shares");
    }
  }

  // One batch (a single D1 transaction): deleted rows with the import not marked undone would be stuck.
  await db.batch([
    db.delete(transactions).where(eq(transactions.importId, args.importId)),
    db.update(imports).set({ status: "undone" }).where(eq(imports.id, args.importId)),
  ]);

  return { deleted: rows.length };
};

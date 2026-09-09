import { and, eq, inArray } from "drizzle-orm";

import { EUR } from "../../core/money.ts";
import type { Db } from "../db/index.ts";
import { imports, transactions } from "../db/schema.ts";
import type { BankRow } from "./bank-statement.ts";

export type BankCommitResult = {
  readonly importId: number;
  readonly inserted: number;
  /** Rows the account already had, matched on the bank's own archive id. */
  readonly skipped: number;
  /**
   * Stored rows that gained a payee from this file. The CSV leaves the column
   * empty where the PDF names the shop, and both carry the same archive id, so
   * dropping the second as a duplicate would throw that away.
   */
  readonly enriched: number;
};

/** What one row is stored as: its identity, and the archive id worth keeping. */
type Identity = { readonly contentHash: string; readonly externalId: string | null };

const materialOf = (accountId: number, row: BankRow): string =>
  `bank:${accountId}:${row.date}:${row.amount}:${row.note}`;

/**
 * Every row's identity, decided across the whole file rather than row by row.
 *
 * The bank's archive id identifies a row only when this file prints it on one
 * row alone. An id on two rows is not an archive id -- a recipe that reads a
 * payer's identifier or an LEI off a detail line hands every payment to one
 * company the same string -- and taking it at its word dropped the second row
 * as already imported, money the balance check then could not account for.
 *
 * What is left falls back to the row's own material, with the count of
 * identical earlier rows appended. Two genuinely identical payments on one day
 * stay two rows, and the same file imported twice still matches itself: the
 * rows arrive in the same order, so they are numbered the same way. The first
 * occurrence keeps the bare material, which is what rows stored before this
 * numbering existed were written under.
 */
const identitiesOf = (accountId: number, rows: readonly BankRow[]): readonly Identity[] => {
  const idCounts = new Map<string, number>();
  for (const row of rows) {
    if (row.externalId === null) continue;
    idCounts.set(row.externalId, (idCounts.get(row.externalId) ?? 0) + 1);
  }

  const seen = new Map<string, number>();
  return rows.map((row) => {
    if (row.externalId !== null && idCounts.get(row.externalId) === 1) {
      return { contentHash: row.externalId, externalId: row.externalId };
    }
    // The id is dropped as well as ignored: `txn_external_uq` would refuse the
    // second row carrying it, and refuse the whole batch with it.
    const material = materialOf(accountId, row);
    const before = seen.get(material) ?? 0;
    seen.set(material, before + 1);
    return {
      contentHash: before === 0 ? material : `${material}#${before}`,
      externalId: null,
    };
  });
};

/**
 * Writes a statement under one import record, so the whole file undoes as a unit.
 *
 * Bank rows carry no instrument, so none of the securities machinery applies. The
 * ledger's unique index still does, and is checked first so a duplicate is
 * reported as a skip rather than thrown by the insert.
 */
export const commitBankStatement = async (
  db: Db,
  args: {
    userId: string;
    accountId: number;
    filename: string;
    sha256: string;
    rows: readonly BankRow[];
  },
): Promise<BankCommitResult> => {
  let inserted = 0;
  let skipped = 0;
  let enriched = 0;

  // The import record first, because every row below references its id and D1
  // has no interactive transaction to read a generated id inside.
  const record = await db
    .insert(imports)
    .values({
      userId: args.userId,
      kind: "csv_bank",
      filename: args.filename,
      sha256: args.sha256,
      status: "committed",
      rowCount: args.rows.length,
    })
    .returning()
    .get();
  if (record === undefined) throw new Error("Tuontitietueen luonti epäonnistui");

  // Every hash this file would write, looked up in bulk rather than one query
  // per row: a year of card payments is several hundred rows, and a statement
  // is normally re-imported with most of it already stored. D1 caps bound
  // parameters per statement, so the lookup goes out in chunks rather than as
  // one IN list.
  const HASH_CHUNK = 90;
  const identities = identitiesOf(args.accountId, args.rows);
  const hashes = identities.map((identity) => identity.contentHash);
  const found = [];
  for (let i = 0; i < hashes.length; i += HASH_CHUNK) {
    found.push(
      ...(await db
        .select({
          id: transactions.id,
          contentHash: transactions.contentHash,
          note: transactions.note,
        })
        .from(transactions)
        .where(
          and(
            eq(transactions.accountId, args.accountId),
            inArray(transactions.contentHash, hashes.slice(i, i + HASH_CHUNK)),
          ),
        )
        .all()),
    );
  }
  const stored = new Map(found.map((row) => [row.contentHash, row]));
  const existing = new Set(stored.keys());

  // The loop only decides -- it reads nothing -- so every write it produces can
  // go out as one batch, which D1 runs as a single transaction.
  const writes = [];

  for (const [order, row] of args.rows.entries()) {
    // SAFETY: `identities` is built from `args.rows`, so it is the same length.
    const { contentHash, externalId } = identities[order]!;
    if (existing.has(contentHash)) {
      skipped++;
      // Only ever fills a blank: a note this file can say more about gets the
      // fuller text, and one that already names a payee is left alone. The
      // amounts, dates and identity are the same row either way.
      const previous = stored.get(contentHash);
      if (previous && row.counterparty !== "" && !(previous.note ?? "").includes(" — ")) {
        writes.push(
          db.update(transactions).set({ note: row.note }).where(eq(transactions.id, previous.id)),
        );
        enriched++;
      }
      continue;
    }
    existing.add(contentHash);

    writes.push(
      db.insert(transactions).values({
        accountId: args.accountId,
        instrumentId: null,
        type: row.type,
        tradeDate: row.date,
        quantity: 0,
        unitPrice: null,
        amount: Number(row.amount),
        fee: 0,
        tax: 0,
        currency: EUR,
        fxRateEur: 100_000_000,
        externalId,
        contentHash,
        importId: record.id,
        note: row.note,
      }),
    );
    inserted++;
  }

  writes.push(
    db
      .update(imports)
      .set({ insertedCount: inserted, skippedCount: skipped })
      .where(eq(imports.id, record.id)),
  );

  // SAFETY: `db.batch` is typed as a non-empty tuple; the `imports` update
  // pushed immediately above is what establishes `writes` is non-empty.
  await db.batch(writes as [(typeof writes)[number], ...typeof writes]);

  return { importId: record.id, inserted, skipped, enriched };
};

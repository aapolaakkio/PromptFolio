import { and, eq, inArray } from "drizzle-orm";

import { EUR } from "../../core/money.ts";
import type { Db } from "../db/index.ts";
import { imports, transactions } from "../db/schema.ts";
import type { BankRow } from "./bank-statement.ts";

export type BankCommitResult = {
  readonly importId: number;
  readonly inserted: number;
  readonly skipped: number;
  readonly enriched: number;
};

type Identity = { readonly contentHash: string; readonly externalId: string | null };

const materialOf = (accountId: number, row: BankRow): string =>
  `bank:${accountId}:${row.date}:${row.amount}:${row.note}`;

/** An archive id counts only when printed on one row alone; the rest hash material plus the count of identical earlier rows. */
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
    // Drop the id too: `txn_external_uq` would refuse the whole batch.
    const material = materialOf(accountId, row);
    const before = seen.get(material) ?? 0;
    seen.set(material, before + 1);
    return {
      contentHash: before === 0 ? material : `${material}#${before}`,
      externalId: null,
    };
  });
};

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

  // First: every row references its id, and D1 has no interactive transaction.
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
  if (record === undefined) throw new Error("Creating the import record failed");

  // Looked up in bulk, not per row; chunked because D1 caps bound parameters per statement.
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

  // The loop only decides, so all writes go out as one batch (one D1 transaction).
  const writes = [];

  for (const [order, row] of args.rows.entries()) {
    // SAFETY: `identities` is built from `args.rows`, so it is the same length.
    const { contentHash, externalId } = identities[order]!;
    if (existing.has(contentHash)) {
      skipped++;
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

  // SAFETY: `db.batch` wants a non-empty tuple; the `imports` update above makes it non-empty.
  await db.batch(writes as [(typeof writes)[number], ...typeof writes]);

  return { importId: record.id, inserted, skipped, enriched };
};

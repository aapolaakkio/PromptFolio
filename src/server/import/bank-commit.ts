import { and, eq, inArray } from "drizzle-orm";

import { EUR } from "../../core/money.ts";
import type { getDb } from "../db/index.ts";
import { imports, transactions } from "../db/schema.ts";
import type { BankRow } from "./bank-statement.ts";

type Db = ReturnType<typeof getDb>["db"];

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

/**
 * A row's identity for deduplication: the bank's archive id, which makes an
 * overlapping re-import safe, or the row's own material where a bank prints none.
 *
 * Under the fallback two identical payments on one day collapse into one. A real
 * limitation, and the safer direction: an overstated balance nobody can explain
 * is worse than a missing duplicate the statement can be re-checked against.
 */
const identityOf = (accountId: number, row: BankRow): string =>
  row.externalId ?? `bank:${accountId}:${row.date}:${row.amount}:${row.note}`;

/**
 * Writes a statement under one import record, so the whole file undoes as a unit.
 *
 * Bank rows carry no instrument, so none of the securities machinery applies. The
 * ledger's unique index still does, and is checked first so a duplicate is
 * reported as a skip rather than thrown by the insert.
 */
export const commitBankStatement = (
  db: Db,
  args: {
    userId: string;
    accountId: number;
    filename: string;
    sha256: string;
    rows: readonly BankRow[];
  },
): BankCommitResult => {
  let inserted = 0;
  let skipped = 0;
  let enriched = 0;
  let importId = 0;

  db.transaction((tx) => {
    const record = tx
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
    importId = record.id;

    // Every hash this file would write, looked up in one query rather than one
    // per row: a year of card payments is several hundred rows, and a
    // statement is normally re-imported with most of it already stored.
    const hashes = args.rows.map((row) => identityOf(args.accountId, row));
    const stored = new Map(
      tx
        .select({
          id: transactions.id,
          contentHash: transactions.contentHash,
          note: transactions.note,
        })
        .from(transactions)
        .where(
          and(
            eq(transactions.accountId, args.accountId),
            inArray(transactions.contentHash, hashes),
          ),
        )
        .all()
        .map((row) => [row.contentHash, row]),
    );
    const existing = new Set(stored.keys());

    for (const row of args.rows) {
      const contentHash = identityOf(args.accountId, row);
      if (existing.has(contentHash)) {
        skipped++;
        // Only ever fills a blank: a note this file can say more about gets the
        // fuller text, and one that already names a payee is left alone. The
        // amounts, dates and identity are the same row either way.
        const previous = stored.get(contentHash);
        if (previous && row.counterparty !== "" && !(previous.note ?? "").includes(" — ")) {
          tx.update(transactions)
            .set({ note: row.note })
            .where(eq(transactions.id, previous.id))
            .run();
          enriched++;
        }
        continue;
      }
      existing.add(contentHash);

      tx.insert(transactions)
        .values({
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
          externalId: row.externalId,
          contentHash,
          importId: record.id,
          note: row.note,
        })
        .run();
      inserted++;
    }

    tx.update(imports)
      .set({ insertedCount: inserted, skippedCount: skipped })
      .where(eq(imports.id, record.id))
      .run();
  });

  return { importId, inserted, skipped, enriched };
};

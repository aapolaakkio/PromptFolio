import { eq } from "drizzle-orm";

import { formatQuantity } from "../core/money.ts";
import { reconcile, type SnapshotPosition } from "../core/reconcile.ts";
import type { Txn } from "../core/types.ts";
import type { Db } from "./db/index.ts";
import { accounts, snapshotRows, snapshots } from "./db/schema.ts";
import { loadPortfolio } from "./valuation.ts";

type AccountCheck = {
  readonly account: string;
  readonly asOf: string | null;
  readonly source: string | null;
  readonly differences: number;
  readonly rows: readonly {
    readonly name: string;
    readonly derived: string;
    readonly snapshot: string;
    readonly delta: string;
  }[];
};

/** Each brokerage account against its newest imported holdings statement: the check every transaction-derived figure rests on. No statement is reported as unchecked, never as agreeing. */
export const reconciliationFor = async (
  db: Db,
  userId: string,
): Promise<readonly AccountCheck[]> => {
  const owned = (
    await db
      .select({ id: accounts.id, name: accounts.name, kind: accounts.kind })
      .from(accounts)
      .where(eq(accounts.userId, userId))
      .all()
  ).filter((account) => account.kind !== "bank");

  const { txns, instruments } = await loadPortfolio(db, userId);
  const nameOf = new Map(instruments.map((instrument) => [instrument.id, instrument.name]));

  // Sequential: a household has few accounts, and an ordered pass keeps a failure attributable.
  const checks: AccountCheck[] = [];
  for (const account of owned) {
    const newest = (
      await db.select().from(snapshots).where(eq(snapshots.accountId, account.id)).all()
    ).sort((a, b) => b.asOf.localeCompare(a.asOf))[0];

    if (newest === undefined) {
      checks.push({ account: account.name, asOf: null, source: null, differences: 0, rows: [] });
      continue;
    }

    const stated: SnapshotPosition[] = (
      await db.select().from(snapshotRows).where(eq(snapshotRows.snapshotId, newest.id)).all()
    ).map((row) => ({
      instrumentId: row.instrumentId,
      quantity: { scaled: BigInt(row.quantity) },
    }));

    // This account's rows only: comparing against the whole portfolio would report every other holding as a difference.
    const own: Txn[] = txns.filter((txn) => txn.accountId === account.id);
    const differing = reconcile(own, stated, newest.asOf).filter((row) => !row.withinTolerance);

    checks.push({
      account: account.name,
      asOf: newest.asOf,
      source: newest.source,
      differences: differing.length,
      rows: differing.map((row) => ({
        name: nameOf.get(row.instrumentId) ?? `#${row.instrumentId}`,
        derived: formatQuantity(row.derived),
        snapshot: formatQuantity(row.snapshot),
        delta: formatQuantity(row.delta),
      })),
    });
  }
  return checks;
};

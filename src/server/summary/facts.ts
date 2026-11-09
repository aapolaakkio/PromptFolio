import { and, eq, gte } from "drizzle-orm";
import { z } from "zod";

import { yearlyCostSummary } from "../../core/fund-costs.ts";
import {
  addMoney,
  divMoney,
  EUR,
  formatMoney,
  negateMoney,
  parseMoney,
  subMoney,
  zeroMoney,
  type Money,
} from "../../core/money.ts";
import type { Db } from "../db/index.ts";
import { accounts, imports, instruments, transactions } from "../db/schema.ts";
import { redacted } from "../import/suggest-rows.ts";
import { notSpendingIds } from "../spending/internal.ts";
import { recurringPayments } from "../spending/recurring.ts";
import { rulesFor } from "../spending/rules.ts";
import { holdingsFor, loadPortfolio } from "../valuation.ts";
import { spendingView, uncategorisedView, valueSeriesView } from "../views/portfolio.ts";

const WINDOW_DAYS = 7;
const BASELINE_WEEKS = 12;
const MAX_MOVERS = 3;
const MAX_NAMES = 10;
const RECURRING_LOOKBACK_DAYS = 400;
const DAY_MS = 86_400_000;

/** Counts and euro totals of the owner's own portfolio, plus instrument names. No account numbers and no payee names: this JSON is what the model sees. */
export const SummaryFacts = z.object({
  windowDays: z.number(),
  baselineWeeks: z.number(),
  totalValueEur: z.string(),
  changeEur: z.string(),
  changePct: z.string().nullable(),
  movers: z.array(z.object({ name: z.string(), changeEur: z.string(), changePct: z.string() })),
  importsMade: z.number(),
  newInstrumentCount: z.number(),
  newInstruments: z.array(z.string()),
  needsAttentionCount: z.number(),
  needsAttention: z.array(z.object({ name: z.string(), reason: z.string() })),
  uncategorisedRows: z.number(),
  spendingThisWeekEur: z.string(),
  spendingWeeklyAverageEur: z.string(),
  recurringChanged: z.number(),
  yearlyFundCostEur: z.string().nullable(),
});
export type SummaryFacts = z.infer<typeof SummaryFacts>;

const day = (now: Date, daysBack: number): string =>
  new Date(now.getTime() - daysBack * DAY_MS).toISOString().slice(0, 10);

const ofText = (text: string): Money => parseMoney(text, EUR);

const spent = (totalEur: string): Money => {
  const total = ofText(totalEur);
  return total.minor < 0n ? negateMoney(total) : zeroMoney(EUR);
};

const pctText = (change: Money, base: Money): string | null =>
  base.minor === 0n
    ? null
    : ((Number(change.minor) * 100) / Math.abs(Number(base.minor))).toFixed(1);

const valueChange = async (db: Db, userId: string, from: string, to: string) => {
  const series = await valueSeriesView(db, userId, from, to);
  const total = (point: (typeof series)[number] | undefined): Money =>
    point === undefined ? zeroMoney(EUR) : addMoney(ofText(point.valueEur), ofText(point.cashEur));
  const start = total(series[0]);
  const end = total(series.at(-1));
  const change = subMoney(end, start);
  return { end, change, pct: pctText(change, start) };
};

/** Only holdings with the same quantity both days: a purchase is not a price move. */
const biggestMovers = async (db: Db, userId: string, from: string, to: string) => {
  const [before, after] = await Promise.all([
    holdingsFor(db, userId, from),
    holdingsFor(db, userId, to),
  ]);
  const earlier = new Map(before.map((holding) => [holding.instrumentId, holding]));
  return after
    .flatMap((holding) => {
      const then = earlier.get(holding.instrumentId);
      if (then === undefined || then.quantity !== holding.quantity) return [];
      if (then.valueEur === null || holding.valueEur === null) return [];
      const change = subMoney(ofText(holding.valueEur), ofText(then.valueEur));
      const pct = pctText(change, ofText(then.valueEur));
      return change.minor === 0n || pct === null
        ? []
        : [{ name: redacted(holding.name), change, pct }];
    })
    .sort((a, b) => Math.abs(Number(b.change.minor)) - Math.abs(Number(a.change.minor)))
    .slice(0, MAX_MOVERS)
    .map((mover) => ({
      name: mover.name,
      changeEur: formatMoney(mover.change),
      changePct: mover.pct,
    }));
};

const REASONS = {
  stale: "price is stale",
  attention: "lookup needs attention",
  pending: "lookup is pending",
} as const;

const importsSince = async (db: Db, userId: string, since: Date): Promise<number> =>
  (
    await db
      .select({ id: imports.id })
      .from(imports)
      .where(
        and(
          eq(imports.userId, userId),
          eq(imports.status, "committed"),
          gte(imports.createdAt, since),
        ),
      )
      .all()
  ).length;

/** Instruments the owner holds a row for that were created in the window; the table itself is shared between users. */
const newInstrumentsSince = async (db: Db, userId: string, since: Date): Promise<string[]> => {
  const rows = await db
    .selectDistinct({ id: instruments.id, name: instruments.name })
    .from(instruments)
    .innerJoin(transactions, eq(transactions.instrumentId, instruments.id))
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .where(and(eq(accounts.userId, userId), gte(instruments.createdAt, since)))
    .all();
  return rows.map((row) => redacted(row.name));
};

const recurringChanged = async (db: Db, userId: string, now: Date): Promise<number> => {
  const { txns, bankAccountIds } = await loadPortfolio(db, userId);
  const bank = new Set(bankAccountIds);
  const args = {
    txns,
    rules: await rulesFor(db, userId),
    bankAccountIds: bank,
    excludedIds: notSpendingIds(txns, bank),
    from: day(now, RECURRING_LOOKBACK_DAYS),
  };
  const before = new Map(
    recurringPayments({ ...args, to: day(now, WINDOW_DAYS) }).map((p) => [p.payee, p.typicalEur]),
  );
  return recurringPayments({ ...args, to: day(now, 0) }).filter((payment) => {
    const earlier = before.get(payment.payee);
    return earlier !== undefined && earlier !== payment.typicalEur;
  }).length;
};

export const gatherFacts = async (db: Db, userId: string, now: Date): Promise<SummaryFacts> => {
  const today = day(now, 0);
  const weekAgo = day(now, WINDOW_DAYS);
  const since = new Date(now.getTime() - WINDOW_DAYS * DAY_MS);
  const baselineFrom = day(now, WINDOW_DAYS + BASELINE_WEEKS * WINDOW_DAYS - 1);

  // In turn, not together: the first spending read seeds the user's rules, and two seeds collide.
  const value = await valueChange(db, userId, weekAgo, today);
  const movers = await biggestMovers(db, userId, weekAgo, today);
  const holdings = await holdingsFor(db, userId, today);
  const importsMade = await importsSince(db, userId, since);
  const created = await newInstrumentsSince(db, userId, since);
  const thisWeek = await spendingView(db, userId, day(now, WINDOW_DAYS - 1), today, "category", 1);
  const baseline = await spendingView(db, userId, baselineFrom, weekAgo, "category", 1);
  const uncategorised = await uncategorisedView(db, userId, baselineFrom, today);
  const changed = await recurringChanged(db, userId, now);

  const attention = holdings.flatMap((holding) => {
    const reason = holding.stale
      ? REASONS.stale
      : holding.lookupStatus === "ok"
        ? null
        : REASONS[holding.lookupStatus];
    return reason === null ? [] : [{ name: redacted(holding.name), reason }];
  });

  return {
    windowDays: WINDOW_DAYS,
    baselineWeeks: BASELINE_WEEKS,
    totalValueEur: formatMoney(value.end),
    changeEur: formatMoney(value.change),
    changePct: value.pct,
    movers,
    importsMade,
    newInstrumentCount: created.length,
    newInstruments: created.slice(0, MAX_NAMES),
    needsAttentionCount: attention.length,
    needsAttention: attention.slice(0, MAX_NAMES),
    uncategorisedRows: uncategorised.merchants.reduce((sum, group) => sum + group.count, 0),
    spendingThisWeekEur: formatMoney(spent(thisWeek.totalEur)),
    spendingWeeklyAverageEur: formatMoney(
      divMoney(spent(baseline.totalEur), BigInt(BASELINE_WEEKS)),
    ),
    recurringChanged: changed,
    yearlyFundCostEur: yearlyCostSummary(holdings).totalEur,
  };
};

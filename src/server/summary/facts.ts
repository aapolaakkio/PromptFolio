import { and, eq, gte } from "drizzle-orm";
import { z } from "zod";

import { cashSeries } from "../../core/cash.ts";
import { yearlyCostSummary } from "../../core/fund-costs.ts";
import { fundingCashFlows } from "../../core/ledger.ts";
import { valueSeries } from "../../core/returns.ts";
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
import { maskAccountNumbers } from "../chat/mask.ts";
import { notSpendingIds } from "../spending/internal.ts";
import { recurringPayments } from "../spending/recurring.ts";
import { rulesFor } from "../spending/rules.ts";
import { holdingsFor, loadPortfolio } from "../valuation.ts";
import { spendingView, uncategorisedView } from "../views/portfolio.ts";
import { helsinkiToday, shiftDay } from "./helsinki.ts";

const WINDOW_DAYS = 7;
const BASELINE_WEEKS = 12;
const MAX_MOVERS = 3;
const MAX_NAMES = 10;
const MAX_NEW_NAMES = 5;
const RECURRING_LOOKBACK_DAYS = 400;
const DAY_MS = 86_400_000;

/** Counts and euro totals of the owner's own portfolio, plus instrument names. No account numbers and no payee names: this JSON is what the model sees. */
export const SummaryFacts = z.object({
  totalValueEur: z.string(),
  netDepositsEur: z.string(),
  changeExcludingDepositsEur: z.string(),
  changePct: z.string().nullable(),
  changeDirection: z.enum(["up", "down", "flat"]),
  /** Some holding had no real price a week ago, so the change is a rough figure. */
  changeIsEstimate: z.boolean(),
  movers: z.array(
    z.object({
      name: z.string(),
      changeEur: z.string(),
      changePct: z.string(),
      direction: z.enum(["up", "down"]),
    }),
  ),
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

const day = (now: Date, daysBack: number): string => shiftDay(helsinkiToday(now), -daysBack);

const ofText = (text: string): Money => parseMoney(text, EUR);

const spent = (totalEur: string): Money => {
  const total = ofText(totalEur);
  return total.minor < 0n ? negateMoney(total) : zeroMoney(EUR);
};

const pctText = (change: Money, base: Money): string | null =>
  base.minor === 0n
    ? null
    : ((Number(change.minor) * 100) / Math.abs(Number(base.minor))).toFixed(1);

/** Investments plus the cash of the accounts that hold them; a bank account's spending is not a portfolio loss. */
const valueChange = async (db: Db, userId: string, from: string, to: string) => {
  const { investedTxns, cashTxns, instruments, prices, bankAccountIds } = await loadPortfolio(
    db,
    userId,
  );
  const bank = new Set(bankAccountIds);
  const values = valueSeries(investedTxns, instruments, prices, from, to);
  const cash = cashSeries(
    cashTxns.filter((txn) => !bank.has(txn.accountId)),
    prices.fxOn,
    from,
    to,
  );
  const total = (index: number): Money =>
    addMoney(
      values.at(index)?.valueEur ?? zeroMoney(EUR),
      cash.at(index)?.cashEur ?? zeroMoney(EUR),
    );
  const start = total(0);
  const end = total(-1);
  const deposits = fundingCashFlows(investedTxns)
    .filter((flow) => flow.date > from && flow.date <= to)
    .reduce((sum, flow) => addMoney(sum, flow.amountEur), zeroMoney(EUR));
  const change = subMoney(subMoney(end, start), deposits);
  return { end, deposits, change, pct: pctText(change, start) };
};

/** A price a week ago that is stored and fresh; anything else (cost, carried forward, missing) is not a real start. */
const isRealValue = (holding: { stale: boolean; valueEur: string | null }): boolean =>
  !holding.stale && holding.valueEur !== null;

/** Only holdings with the same quantity both days and a real price both days: a purchase or a guess is not a price move. */
const biggestMovers = (
  before: Awaited<ReturnType<typeof holdingsFor>>,
  after: Awaited<ReturnType<typeof holdingsFor>>,
) => {
  const earlier = new Map(before.map((holding) => [holding.instrumentId, holding]));
  return after
    .flatMap((holding) => {
      const then = earlier.get(holding.instrumentId);
      if (then === undefined || then.quantity !== holding.quantity) return [];
      if (!isRealValue(then) || !isRealValue(holding)) return [];
      const change = subMoney(ofText(holding.valueEur ?? "0"), ofText(then.valueEur ?? "0"));
      const pct = pctText(change, ofText(then.valueEur ?? "0"));
      return change.minor === 0n || pct === null
        ? []
        : [{ name: maskAccountNumbers(holding.name), change, pct }];
    })
    .sort((a, b) => Math.abs(Number(b.change.minor)) - Math.abs(Number(a.change.minor)))
    .slice(0, MAX_MOVERS)
    .map((mover) => ({
      name: mover.name,
      changeEur: formatMoney(mover.change),
      changePct: mover.pct,
      direction: mover.change.minor > 0n ? ("up" as const) : ("down" as const),
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
  return rows.map((row) => maskAccountNumbers(row.name));
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
  const holdingsBefore = await holdingsFor(db, userId, weekAgo);
  const holdings = await holdingsFor(db, userId, today);
  const movers = biggestMovers(holdingsBefore, holdings);
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
    return reason === null ? [] : [{ name: maskAccountNumbers(holding.name), reason }];
  });

  return {
    totalValueEur: formatMoney(value.end),
    netDepositsEur: formatMoney(value.deposits),
    changeExcludingDepositsEur: formatMoney(value.change),
    changePct: value.pct,
    changeDirection: value.change.minor === 0n ? "flat" : value.change.minor > 0n ? "up" : "down",
    changeIsEstimate: !holdingsBefore.every(isRealValue),
    movers,
    importsMade,
    newInstrumentCount: created.length,
    newInstruments: created.slice(0, MAX_NEW_NAMES),
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

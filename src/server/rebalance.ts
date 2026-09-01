import { and, eq } from "drizzle-orm";

import { allocateBy, sliceKeyFor, type Dimension } from "../core/allocation.ts";
import { cashBalancesAt, valueCash } from "../core/cash.ts";
import { costBasisPerInstrument } from "../core/costbasis.ts";
import { positionsAt } from "../core/ledger.ts";
import {
  addMoney,
  formatMoney,
  money,
  mulMoney,
  subMoney,
  toEur,
  zeroMoney,
  EUR,
  type Money,
} from "../core/money.ts";
import { allocateDeposit } from "../core/rebalance/deposit.ts";
import { driftFor, type DriftRow } from "../core/rebalance/drift.ts";
import { feesByYear } from "../core/rebalance/fees.ts";
import { attributeSale, rebalancePlan } from "../core/rebalance/plan.ts";
import { checkTargets, type Target } from "../core/rebalance/targets.ts";
import type { IsoDate } from "../core/types.ts";
import { chunkForInsert, type Db } from "./db/index.ts";
import { accounts, allocationTargets } from "./db/schema.ts";
import { loadPortfolio, withAvailability } from "./valuation.ts";

export type TargetView = { readonly key: string; readonly weightPercent: string };

export type DriftRowView = {
  readonly key: string;
  readonly label: string;
  readonly actualPercent: string;
  readonly targetPercent: string | null;
  readonly driftPercent: string | null;
  readonly driftEur: string | null;
  readonly withinBand: boolean;
  readonly untargeted: boolean;
};

export type DriftView = {
  readonly dimension: Dimension;
  readonly rows: readonly DriftRowView[];
  readonly totalEur: string;
  readonly incomplete: boolean;
};

export type DepositView = {
  readonly key: string;
  readonly label: string;
  readonly amountEur: string;
};

export type TradeView = {
  readonly key: string;
  readonly label: string;
  readonly side: "buy" | "sell";
  readonly amountEur: string;
  readonly realisedGainEur: string | null;
  readonly gainUnknown: boolean;
};

export type PlanView = {
  readonly trades: readonly TradeView[];
  readonly tooSmall: readonly TradeView[];
  readonly totalRealisedGainEur: string;
  readonly gainIncomplete: boolean;
  readonly balanced: boolean;
};

export type FeeYearView = {
  readonly year: number;
  readonly tradeFeesEur: string;
  readonly chargedFeesEur: string;
  readonly totalEur: string;
  readonly withheldTaxEur: string;
};

/** A basis-point weight as the decimal string the wire carries. */
const asPercent = (bp: number): string => (bp / 100).toFixed(2);

export const targetsFor = async (
  db: Db,
  userId: string,
  dimension: Dimension,
): Promise<readonly TargetView[]> =>
  (await storedTargets(db, userId, dimension)).map((target) => ({
    key: target.key,
    weightPercent: asPercent(target.weightBp),
  }));

const storedTargets = async (db: Db, userId: string, dimension: Dimension): Promise<Target[]> =>
  (
    await db
      .select()
      .from(allocationTargets)
      .where(and(eq(allocationTargets.userId, userId), eq(allocationTargets.dimension, dimension)))
      .all()
  ).map((row) => ({ key: row.key, weightBp: row.weightBp }));

/**
 * Replaces a dimension's targets in one transaction. Wholesale, never added to: a
 * set is a statement about the whole portfolio, and inserting into one leaves it
 * summing to something other than 100 %, refused only on the next read.
 */
export const saveTargets = async (
  db: Db,
  userId: string,
  dimension: Dimension,
  targets: readonly Target[],
): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }> => {
  const error = checkTargets(targets);
  if (error !== null) return { ok: false, message: error.message };

  const rows = targets.map((target) => ({
    userId,
    dimension,
    key: target.key,
    weightBp: target.weightBp,
  }));

  // One batch, which D1 runs as a single transaction. That is the whole point
  // here: a delete that lands without its inserts would leave the dimension
  // with no targets at all. Chunked because a set of 25 targets already binds
  // more variables than D1 allows in one statement.
  await db.batch([
    db
      .delete(allocationTargets)
      .where(and(eq(allocationTargets.userId, userId), eq(allocationTargets.dimension, dimension))),
    ...chunkForInsert(rows, 4).map((chunk) => db.insert(allocationTargets).values(chunk)),
  ]);
  return { ok: true };
};

/** What every read view needs: the allocation, the targets, and the drift between them. */
const situation = async (db: Db, userId: string, dimension: Dimension, on: IsoDate) => {
  const { txns, cashTxns, instruments, prices } = await loadPortfolio(db, userId);
  const cash = await withAvailability(
    db,
    userId,
    valueCash(cashBalancesAt(cashTxns, on), prices.fxOn, on),
    on,
  );
  const allocation = allocateBy(txns, instruments, prices, on, dimension, cash);
  const targets = await storedTargets(db, userId, dimension);
  return { txns, instruments, prices, targets, report: driftFor({ allocation, targets }) };
};

const asRowView = (row: DriftRow): DriftRowView => ({
  key: row.key,
  label: row.label,
  actualPercent: asPercent(row.actualBp),
  targetPercent: row.targetBp === null ? null : asPercent(row.targetBp),
  driftPercent: row.driftBp === null ? null : asPercent(row.driftBp),
  driftEur: row.driftEur === null ? null : formatMoney(row.driftEur),
  withinBand: row.withinBand,
  untargeted: row.untargeted,
});

export const driftReportFor = async (
  db: Db,
  userId: string,
  dimension: Dimension,
  on: IsoDate,
): Promise<DriftView> => {
  const { report } = await situation(db, userId, dimension, on);
  return {
    dimension,
    rows: report.rows.map(asRowView),
    totalEur: formatMoney(report.totalEur),
    incomplete: report.incomplete,
  };
};

export const depositPlanFor = async (
  db: Db,
  userId: string,
  dimension: Dimension,
  on: IsoDate,
  depositEur: Money,
): Promise<readonly DepositView[]> => {
  const { report, targets } = await situation(db, userId, dimension, on);
  return allocateDeposit({
    rows: report.rows,
    targets,
    totalEur: report.totalEur,
    depositEur,
  }).map((allocation) => ({
    key: allocation.key,
    label: allocation.label,
    amountEur: formatMoney(allocation.amountEur),
  }));
};

/** One holding's market value and cost, for attributing a slice-level sale. */
type SliceHolding = {
  readonly instrumentId: number;
  readonly valueEur: Money;
  readonly costEur: Money | null;
};

/**
 * What each slice holds, valued and costed, keyed by slice.
 *
 * Built from the same `sliceKeyFor` the allocation itself uses, so the plan and
 * the drift table cannot disagree about what a slice contains.
 */
const holdingsBySlice = async (
  db: Db,
  userId: string,
  dimension: Dimension,
  on: IsoDate,
): Promise<Map<string, SliceHolding[]>> => {
  const { txns, instruments, prices } = await loadPortfolio(db, userId);
  const byId = new Map(instruments.map((instrument) => [instrument.id, instrument]));
  const costs = costBasisPerInstrument(txns, on);
  const bySlice = new Map<string, SliceHolding[]>();

  for (const accountId of new Set(txns.map((txn) => txn.accountId))) {
    const own = txns.filter((txn) => txn.accountId === accountId);
    for (const [instrumentId, quantity] of positionsAt(own, on)) {
      const instrument = byId.get(instrumentId);
      if (instrument === undefined || quantity.scaled <= 0n) continue;
      const price = prices.priceOn(instrumentId, on);
      if (price === null) continue;
      const rate = instrument.currency === EUR ? null : prices.fxOn(instrument.currency, on);
      if (instrument.currency !== EUR && rate === null) continue;
      const native = mulMoney(price, quantity);
      const valueEur = rate === null ? native : toEur(native, rate);
      const outcome = costs.get(instrumentId);
      const key = sliceKeyFor(dimension, accountId, instrument);
      bySlice.set(key, [
        ...(bySlice.get(key) ?? []),
        { instrumentId, valueEur, costEur: outcome?.ok === true ? outcome.costEur : null },
      ]);
    }
  }
  return bySlice;
};

export const rebalancePlanFor = async (
  db: Db,
  userId: string,
  dimension: Dimension,
  on: IsoDate,
): Promise<PlanView> => {
  const { report } = await situation(db, userId, dimension, on);
  const bySlice = await holdingsBySlice(db, userId, dimension, on);

  /**
   * What a slice-level sale would realise. A slice names no instrument, so the
   * sale spreads across what it holds, largest first, each part realising its
   * share of that holding's gain. Unknown rather than zero as soon as one cost
   * basis is: a partial total shown as a whole one is what this view avoids.
   */
  const gainOnSale = (key: string, amountEur: Money): Money | null => {
    const holdings = bySlice.get(key);
    if (holdings === undefined || holdings.length === 0) return null;

    let gain = zeroMoney(EUR);
    for (const part of attributeSale(holdings, amountEur)) {
      const holding = holdings.find((candidate) => candidate.instrumentId === part.instrumentId);
      if (holding === undefined || holding.costEur === null || holding.valueEur.minor === 0n) {
        return null;
      }
      const unrealised = subMoney(holding.valueEur, holding.costEur);
      gain = addMoney(
        gain,
        money((unrealised.minor * part.amountEur.minor) / holding.valueEur.minor, EUR),
      );
    }
    return gain;
  };

  const plan = rebalancePlan({ rows: report.rows, gainOnSale });
  const asTrade = (trade: (typeof plan.trades)[number]): TradeView => ({
    key: trade.key,
    label: trade.label,
    side: trade.side,
    amountEur: formatMoney(trade.amountEur),
    realisedGainEur: trade.realisedGainEur === null ? null : formatMoney(trade.realisedGainEur),
    gainUnknown: trade.gainUnknown,
  });

  return {
    trades: plan.trades.map(asTrade),
    tooSmall: plan.tooSmall.map(asTrade),
    totalRealisedGainEur: formatMoney(plan.totalRealisedGainEur),
    gainIncomplete: plan.gainIncomplete,
    balanced: plan.balanced,
  };
};

export const feeReportFor = async (db: Db, userId: string): Promise<readonly FeeYearView[]> => {
  const { txns } = await loadPortfolio(db, userId);
  const ostAccountIds = new Set(
    (await db.select().from(accounts).where(eq(accounts.userId, userId)).all())
      .filter((account) => account.accountType === "ost")
      .map((account) => account.id),
  );
  return feesByYear({ txns, ostAccountIds }).map((year) => ({
    year: year.year,
    tradeFeesEur: formatMoney(year.tradeFeesEur),
    chargedFeesEur: formatMoney(year.chargedFeesEur),
    totalEur: formatMoney(year.totalEur),
    withheldTaxEur: formatMoney(year.withheldTaxEur),
  }));
};

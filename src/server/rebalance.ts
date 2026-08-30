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
import type { getDb } from "./db/index.ts";
import { accounts, allocationTargets } from "./db/schema.ts";
import { loadPortfolio, withAvailability } from "./valuation.ts";

type Db = ReturnType<typeof getDb>["db"];

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

export const targetsFor = (db: Db, userId: string, dimension: Dimension): readonly TargetView[] =>
  storedTargets(db, userId, dimension).map((target) => ({
    key: target.key,
    weightPercent: asPercent(target.weightBp),
  }));

const storedTargets = (db: Db, userId: string, dimension: Dimension): Target[] =>
  db
    .select()
    .from(allocationTargets)
    .where(and(eq(allocationTargets.userId, userId), eq(allocationTargets.dimension, dimension)))
    .all()
    .map((row) => ({ key: row.key, weightBp: row.weightBp }));

/**
 * Replaces a user's targets for one dimension, in one transaction.
 *
 * Wholesale, never added to: a set is a statement about the whole portfolio, and
 * inserting into an existing one leaves a set summing to something other than
 * 100 % -- which the check would refuse on the next read, after the write had
 * already happened. Returns the error rather than throwing it, so the route can
 * render the total it actually sums to.
 */
export const saveTargets = (
  db: Db,
  userId: string,
  dimension: Dimension,
  targets: readonly Target[],
): { readonly ok: true } | { readonly ok: false; readonly message: string } => {
  const error = checkTargets(targets);
  if (error !== null) return { ok: false, message: error.message };

  db.transaction((tx) => {
    tx.delete(allocationTargets)
      .where(and(eq(allocationTargets.userId, userId), eq(allocationTargets.dimension, dimension)))
      .run();
    tx.insert(allocationTargets)
      .values(
        targets.map((target) => ({
          userId,
          dimension,
          key: target.key,
          weightBp: target.weightBp,
        })),
      )
      .run();
  });
  return { ok: true };
};

/** What every read view needs: the allocation, the targets, and the drift between them. */
const situation = (db: Db, userId: string, dimension: Dimension, on: IsoDate) => {
  const { txns, cashTxns, instruments, prices } = loadPortfolio(db, userId);
  const cash = withAvailability(
    db,
    userId,
    valueCash(cashBalancesAt(cashTxns, on), prices.fxOn, on),
    on,
  );
  const allocation = allocateBy(txns, instruments, prices, on, dimension, cash);
  const targets = storedTargets(db, userId, dimension);
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

export const driftReportFor = (
  db: Db,
  userId: string,
  dimension: Dimension,
  on: IsoDate,
): DriftView => {
  const { report } = situation(db, userId, dimension, on);
  return {
    dimension,
    rows: report.rows.map(asRowView),
    totalEur: formatMoney(report.totalEur),
    incomplete: report.incomplete,
  };
};

export const depositPlanFor = (
  db: Db,
  userId: string,
  dimension: Dimension,
  on: IsoDate,
  depositEur: Money,
): readonly DepositView[] => {
  const { report, targets } = situation(db, userId, dimension, on);
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
const holdingsBySlice = (
  db: Db,
  userId: string,
  dimension: Dimension,
  on: IsoDate,
): Map<string, SliceHolding[]> => {
  const { txns, instruments, prices } = loadPortfolio(db, userId);
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

export const rebalancePlanFor = (
  db: Db,
  userId: string,
  dimension: Dimension,
  on: IsoDate,
): PlanView => {
  const { report } = situation(db, userId, dimension, on);
  const bySlice = holdingsBySlice(db, userId, dimension, on);

  /**
   * What a slice-level sale would realise.
   *
   * A slice names no instrument, so the sale is attributed across what the slice
   * holds, largest first, and each part realises its share of that holding's
   * unrealised gain -- selling half a holding realises half of what it gained.
   * Unknown, rather than zero, as soon as one holding's cost basis is unknown:
   * a partial total presented as a whole one is the error this view exists to
   * avoid.
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

export const feeReportFor = (db: Db, userId: string): readonly FeeYearView[] => {
  const { txns } = loadPortfolio(db, userId);
  const ostAccountIds = new Set(
    db
      .select()
      .from(accounts)
      .where(eq(accounts.userId, userId))
      .all()
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

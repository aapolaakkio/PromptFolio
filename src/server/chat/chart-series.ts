import { and, asc, eq, gte, lte } from "drizzle-orm";

import { formatMoney, toEur, type Currency } from "../../core/money.ts";
import type { IsoDate } from "../../core/types.ts";
import { prices } from "../db/schema.ts";
import { CATEGORY_LABELS, labelForCategory } from "../spending/categories.ts";
import { loadPortfolio } from "../valuation.ts";
import { allocationView, monthlyView, valueSeriesView } from "../views/portfolio.ts";
import {
  MAX_CHART_POINTS,
  type ChartData,
  type ChartSpec,
  type SeriesRef,
  type YUnit,
} from "./chart-schema.ts";
import type { Db } from "./tool-types.ts";
import { thin } from "./chart-transform.ts";
import type { TurnState } from "./turn-state.ts";

type Unit = YUnit;
type Point = { readonly x: string; readonly y: number; readonly estimated?: boolean };
export type ResolvedSeries = {
  readonly label: string;
  readonly unit: Unit;
  readonly points: readonly Point[];
};

const RANGE_MONTHS = { "3m": 3, "6m": 6, "1y": 12, "3y": 36, "5y": 60, "10y": 120 } as const;

const monthsBefore = (on: IsoDate, months: number): IsoDate => {
  const date = new Date(`${on}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() - months);
  return date.toISOString().slice(0, 10);
};

const rangeStart = (range: keyof typeof RANGE_MONTHS | "max", on: IsoDate): IsoDate | undefined =>
  range === "max" ? undefined : monthsBefore(on, RANGE_MONTHS[range]);

const PATH_LABEL = {
  expected: "expected",
  low: "low (10 %)",
  high: "high (90 %)",
  contributed: "new money put in",
} as const;

/** A scenario of this turn and, optionally, one of its holdings; anything else is refused. */
const scenarioFor = (turn: TurnState, scenarioId: string, holdingId: number | undefined) => {
  const scenario = turn.scenario(scenarioId);
  if (scenario === undefined) {
    throw new Error(
      `Unknown scenario: ${scenarioId}. Use a scenarioId run_forecast returned in this answer`,
    );
  }
  const holding =
    holdingId === undefined
      ? undefined
      : scenario.holdings.find((row) => row.instrumentId === holdingId);
  if (holdingId !== undefined && holding === undefined) {
    throw new Error(`Instrument ${holdingId} is not in scenario ${scenario.id}`);
  }
  return { scenario, holding };
};

/** The low-high range of one scenario, for shading. */
export const forecastBand = (
  turn: TurnState,
  band: NonNullable<ChartSpec["band"]>,
): NonNullable<ChartData["band"]> => {
  const { scenario, holding } = scenarioFor(turn, band.scenarioId, band.holdingId);
  const id = holding === undefined ? null : String(holding.instrumentId);
  return {
    label: `${scenario.id} ${holding === undefined ? "" : `${holding.name} `}range (10-90 %)`,
    points: thin(scenario.result.points).map((point) => {
      const range = id === null ? point.total : point.holdings.find((row) => row.id === id);
      return { x: point.month, low: range?.low ?? 0, high: range?.high ?? 0 };
    }),
  };
};

const forecastSeries = (
  turn: TurnState,
  ref: Extract<SeriesRef, { source: "forecast" }>,
): ResolvedSeries => {
  const { scenario, holding } = scenarioFor(turn, ref.scenarioId, ref.holdingId);
  if (holding !== undefined && ref.path === "contributed") {
    throw new Error("New money put in is for the whole portfolio only; leave out holdingId");
  }
  const id = holding === undefined ? null : String(holding.instrumentId);
  const valueAt = (point: (typeof scenario.result.points)[number]): number => {
    if (ref.path === "contributed") return point.newMoneyEur;
    const band = id === null ? point.total : point.holdings.find((row) => row.id === id);
    return band?.[ref.path] ?? 0;
  };
  return {
    label: `${scenario.id} ${holding === undefined ? "" : `${holding.name} `}${PATH_LABEL[ref.path]}`,
    unit: "EUR",
    points: scenario.result.points.map((point) => ({ x: point.month, y: valueAt(point) })),
  };
};

const allocationSeries = async (
  db: Db,
  userId: string,
  dimension: Extract<SeriesRef, { source: "allocation" }>["dimension"],
  unit: Unit,
  on: IsoDate,
): Promise<ResolvedSeries> => {
  const { slices } = await allocationView(db, userId, dimension, on);
  const asPercent = unit === "%";
  return {
    label: `Allocation by ${dimension}`,
    unit: asPercent ? "%" : "EUR",
    points: slices.slice(0, MAX_CHART_POINTS).map((slice) => ({
      x: slice.label,
      y: asPercent ? Math.round(slice.weight * 10_000) / 100 : Number(slice.valueEur),
    })),
  };
};

const spendingSeries = async (
  db: Db,
  userId: string,
  ref: Extract<SeriesRef, { source: "spending-by-month" }>,
  on: IsoDate,
): Promise<ResolvedSeries> => {
  const { categoryId } = ref;
  if (categoryId !== undefined && !Object.hasOwn(CATEGORY_LABELS, categoryId)) {
    throw new Error(
      `Unknown category: ${categoryId}. Categories: ${Object.keys(CATEGORY_LABELS).join(", ")}`,
    );
  }
  const from = `${monthsBefore(`${on.slice(0, 7)}-01`, ref.months - 1)}`;
  const { months, byCategory } = await monthlyView(db, userId, from, on);
  const points =
    categoryId === undefined
      ? months.map((month) => ({ x: month.month, y: Number(month.expensesEur) }))
      : byCategory.months.map((month) => ({
          x: month.month,
          y: Number(month.byCategory[categoryId] ?? "0"),
        }));
  return {
    label: categoryId === undefined ? "All spending" : labelForCategory(categoryId),
    unit: "EUR",
    points,
  };
};

const priceSeries = async (
  db: Db,
  userId: string,
  ref: Extract<SeriesRef, { source: "holding-price" }>,
  on: IsoDate,
): Promise<ResolvedSeries> => {
  const portfolio = await loadPortfolio(db, userId);
  const instrument = portfolio.instruments.find((row) => row.id === ref.instrumentId);
  // The registry is household-shared: only an instrument this user's own ledger references.
  if (
    instrument === undefined ||
    !portfolio.txns.some((txn) => txn.instrumentId === ref.instrumentId)
  ) {
    throw new Error("Instrument not found. Use an id from get_instruments");
  }
  const from = rangeStart(ref.range, on) ?? "0000-01-01";
  const rows = await db
    .select({ date: prices.date, close: prices.close, currency: prices.currency })
    .from(prices)
    .where(
      and(eq(prices.instrumentId, ref.instrumentId), gte(prices.date, from), lte(prices.date, on)),
    )
    .orderBy(asc(prices.date))
    .all();
  const inEur = rows.flatMap((row) => {
    const money = { minor: BigInt(row.close), currency: row.currency satisfies Currency };
    if (row.currency === "EUR") return [{ x: row.date, y: Number(formatMoney(money)) }];
    const rate = portfolio.prices.fxOn(row.currency, row.date);
    return rate === null ? [] : [{ x: row.date, y: Number(formatMoney(toEur(money, rate))) }];
  });
  return { label: `${instrument.name} price`, unit: "EUR", points: inEur };
};

/** One reference as app-computed numbers for the caller; ids are checked against the caller's own data. */
export const resolveSeries = async (
  db: Db,
  userId: string,
  turn: TurnState,
  ref: SeriesRef,
  unit: Unit,
  on: IsoDate,
): Promise<ResolvedSeries> => {
  switch (ref.source) {
    case "forecast":
      return forecastSeries(turn, ref);
    case "value-series": {
      const series = await valueSeriesView(db, userId, rangeStart(ref.range, on), on);
      return {
        label: "Portfolio value",
        unit: "EUR",
        points: series.map((point) => ({
          x: point.date,
          y: Number(point.valueEur),
          estimated: point.stale || point.costValued,
        })),
      };
    }
    case "spending-by-month":
      return spendingSeries(db, userId, ref, on);
    case "holding-price":
      return priceSeries(db, userId, ref, on);
    case "allocation":
      return allocationSeries(db, userId, ref.dimension, unit, on);
  }
};

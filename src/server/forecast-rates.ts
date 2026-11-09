import { and, asc, eq, inArray, lte } from "drizzle-orm";
import type { z } from "zod";

import type { InstrumentKind, IsoDate } from "../core/types.ts";
import { toBasisPoints } from "./action-inputs.ts";
import type { Db } from "./db/index.ts";
import { forecastRates, instruments, prices } from "./db/schema.ts";
import { HttpError } from "./errors.ts";
import type { ForecastRateInput } from "./forecast-inputs.ts";

export type RateBasis = "history" | "blend" | "default" | "user";

export type ForecastRate = {
  readonly rate: number;
  readonly volatility: number;
  readonly basis: RateBasis;
  readonly yearsOfHistory: number;
};

const DEFAULT_RATE = 0.06;
const DEFAULT_VOLATILITY = 0.18;
const FULL_WEIGHT_YEARS = 10;
const MIN_YEARS = 1;
const CAGR_LIMIT = 0.5;
// The scenario schema caps volatility at 2; a returned scenario must re-validate.
const MAX_VOLATILITY = 2;
const DAY_MS = 86_400_000;
const DAYS_PER_YEAR = 365.25;
const BP_PER_UNIT = 10_000;

type Close = { readonly date: string; readonly close: number };

const yearsBetween = (from: string, to: string): number =>
  (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS / DAYS_PER_YEAR;

const tenYearsBefore = (date: string): string =>
  `${Number(date.slice(0, 4)) - FULL_WEIGHT_YEARS}${date.slice(4)}`;

/** Last close of each calendar month, in date order. */
const monthEnds = (closes: readonly Close[]): number[] => [
  ...new Map(closes.map((row) => [row.date.slice(0, 7), row.close])).values(),
];

/** Sample standard deviation of monthly log returns, annualised; null with fewer than two returns. */
const volatilityOf = (closes: readonly Close[]): number | null => {
  const ends = monthEnds(closes);
  const returns = ends.slice(1).map((close, index) => Math.log(close / (ends[index] ?? close)));
  if (returns.length < 2) return null;
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance =
    returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(12);
};

const defaultsFor = (kind: InstrumentKind) =>
  kind === "cash"
    ? { rate: 0, volatility: 0 }
    : { rate: DEFAULT_RATE, volatility: DEFAULT_VOLATILITY };

/** From the last close on or before ten years back (or the first close), to the last close. */
const windowOf = (closes: readonly Close[], last: Close): readonly Close[] => {
  const cutoff = tenYearsBefore(last.date);
  const startAt = closes.findLastIndex((row) => row.date <= cutoff);
  return closes.slice(Math.max(0, startAt));
};

/** CAGR and volatility over the window, blended with the kind's default by min(window years / 10, 1). */
const measuredRate = (kind: InstrumentKind, closes: readonly Close[]): ForecastRate => {
  const fallback = defaultsFor(kind);
  const last = closes[closes.length - 1];
  const window = last === undefined ? [] : windowOf(closes, last);
  const start = window[0];
  const years = start && last ? yearsBetween(start.date, last.date) : 0;
  const cagr =
    start && last && years > 0 ? (last.close / start.close) ** (1 / years) - 1 : Number.NaN;
  if (kind === "cash" || years < MIN_YEARS || !Number.isFinite(cagr)) {
    return { ...fallback, basis: "default", yearsOfHistory: years };
  }
  const own = Math.min(CAGR_LIMIT, Math.max(-CAGR_LIMIT, cagr));
  const weight = Math.min(years / FULL_WEIGHT_YEARS, 1);
  const measured = volatilityOf(window);
  const ownVolatility =
    measured === null || !Number.isFinite(measured)
      ? fallback.volatility
      : Math.min(MAX_VOLATILITY, measured);
  return {
    rate: weight * own + (1 - weight) * fallback.rate,
    volatility: weight * ownVolatility + (1 - weight) * fallback.volatility,
    basis: weight === 1 ? "history" : "blend",
    yearsOfHistory: years,
  };
};

/** Each instrument's rate as of `on`; the caller's own override replaces the rate, never the volatility. */
export const ratesFor = async (
  db: Db,
  userId: string,
  held: readonly { readonly instrumentId: number; readonly kind: InstrumentKind }[],
  on: IsoDate,
): Promise<Map<number, ForecastRate>> => {
  const ids = held.map((row) => row.instrumentId);
  if (ids.length === 0) return new Map();
  const stored = await db
    .select({ instrumentId: prices.instrumentId, date: prices.date, close: prices.close })
    .from(prices)
    .where(and(inArray(prices.instrumentId, ids), lte(prices.date, on)))
    .orderBy(asc(prices.date))
    .all();
  const overrides = new Map(
    (
      await db
        .select({ instrumentId: forecastRates.instrumentId, rateBp: forecastRates.rateBp })
        .from(forecastRates)
        .where(and(eq(forecastRates.userId, userId), inArray(forecastRates.instrumentId, ids)))
        .all()
    ).map((row) => [row.instrumentId, row.rateBp]),
  );
  return new Map(
    held.map((row) => {
      const measured = measuredRate(
        row.kind,
        stored.filter((close) => close.instrumentId === row.instrumentId && close.close > 0),
      );
      const override = overrides.get(row.instrumentId);
      return [
        row.instrumentId,
        override === undefined
          ? measured
          : { ...measured, rate: override / BP_PER_UNIT, basis: "user" as const },
      ];
    }),
  );
};

export const setRateOverride = async (
  db: Db,
  userId: string,
  input: z.infer<typeof ForecastRateInput>,
): Promise<void> => {
  const known = await db
    .select({ id: instruments.id })
    .from(instruments)
    .where(eq(instruments.id, input.instrumentId))
    .get();
  if (known === undefined) throw new HttpError(404, "Instrument not found");
  const rateBp = toBasisPoints(input.ratePercent);
  await db
    .insert(forecastRates)
    .values({ userId, instrumentId: input.instrumentId, rateBp })
    .onConflictDoUpdate({
      target: [forecastRates.userId, forecastRates.instrumentId],
      set: { rateBp },
    })
    .run();
};

export const removeRateOverride = async (
  db: Db,
  userId: string,
  instrumentId: number,
): Promise<void> => {
  await db
    .delete(forecastRates)
    .where(and(eq(forecastRates.userId, userId), eq(forecastRates.instrumentId, instrumentId)))
    .run();
};

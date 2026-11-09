import { inArray } from "drizzle-orm";
import type { z } from "zod";

import { forecast, type ForecastResult, type ForecastScenario } from "../core/forecast.ts";
import type { InstrumentKind } from "../core/types.ts";
import type { Db } from "./db/index.ts";
import { instruments } from "./db/schema.ts";
import { ForecastOptionsInput } from "./forecast-inputs.ts";
import { ratesFor, type RateBasis } from "./forecast-rates.ts";
import { listPlan } from "./monthly-plan.ts";
import { holdingsFor } from "./valuation.ts";

export type ForecastHoldingView = {
  readonly instrumentId: number;
  readonly name: string;
  readonly kind: InstrumentKind;
  /** The currency its growth is measured in; exchange-rate moves are not forecast. */
  readonly currency: string;
  readonly valueEur: number;
  readonly monthlyEur: number;
  readonly rate: number;
  readonly volatility: number;
  readonly basis: RateBasis;
  readonly yearsOfHistory: number;
};

export type ForecastReport = {
  readonly holdings: readonly ForecastHoldingView[];
  /** Held but without a price today, so left out of the forecast. */
  readonly unvalued: readonly string[];
  readonly scenario: ForecastScenario;
  readonly result: ForecastResult;
};

type Candidate = {
  readonly instrumentId: number;
  readonly name: string;
  readonly kind: InstrumentKind;
  readonly currency: string;
  readonly valueEur: number;
};

const today = (): string => new Date().toISOString().slice(0, 10);

/** Valued holdings, then planned instruments not yet held (worth 0 today). */
const candidatesFor = async (db: Db, userId: string, on: string, planIds: readonly number[]) => {
  const held = await holdingsFor(db, userId, on);
  const valued: Candidate[] = held.flatMap((row) =>
    row.valueEur === null
      ? []
      : [
          {
            instrumentId: row.instrumentId,
            name: row.name,
            kind: row.kind,
            currency: row.currency,
            valueEur: Number(row.valueEur),
          },
        ],
  );
  const heldIds = new Set(held.map((row) => row.instrumentId));
  const unheld = planIds.filter((id) => !heldIds.has(id));
  const planned: Candidate[] =
    unheld.length === 0
      ? []
      : (
          await db
            .select({
              id: instruments.id,
              name: instruments.name,
              kind: instruments.kind,
              currency: instruments.currency,
            })
            .from(instruments)
            .where(inArray(instruments.id, unheld))
            .all()
        ).map((row) => ({
          instrumentId: row.id,
          name: row.name,
          kind: row.kind,
          currency: row.currency,
          valueEur: 0,
        }));
  const unvalued = held.filter((row) => row.valueEur === null).map((row) => row.name);
  return { candidates: [...valued, ...planned], unvalued };
};

/** The caller's own holdings, rates and monthly plan run through the engine; options are checked here. */
export const forecastFor = async (
  db: Db,
  userId: string,
  options: z.input<typeof ForecastOptionsInput>,
): Promise<ForecastReport> => {
  const parsed = ForecastOptionsInput.parse(options);
  const on = parsed.on ?? today();
  const planRows = (await listPlan(db, userId)).rows;
  const monthlyById = new Map(planRows.map((row) => [row.instrumentId, Number(row.amountEur)]));
  const { candidates, unvalued } = await candidatesFor(db, userId, on, [...monthlyById.keys()]);
  const selected =
    parsed.instrumentIds === undefined
      ? candidates
      : candidates.filter((row) => parsed.instrumentIds?.includes(row.instrumentId));
  const rates = await ratesFor(db, userId, selected, on);
  const holdings: ForecastHoldingView[] = selected.map((row) => {
    // SAFETY: ratesFor returns one entry per instrument it was given.
    const rate = rates.get(row.instrumentId) as NonNullable<ReturnType<typeof rates.get>>;
    return { ...row, ...rate, monthlyEur: monthlyById.get(row.instrumentId) ?? 0 };
  });
  const scenario: ForecastScenario = {
    startDate: on.slice(0, 7),
    months: parsed.months,
    holdings: holdings.map((row) => ({
      id: String(row.instrumentId),
      name: row.name,
      valueEur: row.valueEur,
      rate: row.rate,
      volatility: row.volatility,
    })),
    contributions: holdings
      .filter((row) => row.monthlyEur > 0)
      .map((row) => ({ holdingId: String(row.instrumentId), monthlyEur: row.monthlyEur })),
    inflation: parsed.inflation,
    real: parsed.real,
  };
  return { holdings, unvalued, scenario, result: forecast(scenario) };
};

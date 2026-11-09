import {
  forecast,
  monthlyNeeded,
  monthsToReach,
  type ForecastContribution,
  type ForecastResult,
  type ForecastScenario,
} from "../../core/forecast.ts";
import { forecastFor, type ForecastHoldingView } from "../forecast.ts";
import { ForecastScenarioInput } from "../forecast-inputs.ts";
import {
  ForecastTargetInput,
  RunForecastInput,
  type ForecastOverrides,
} from "./forecast-overrides.ts";
import type { ChatTool, Db, ToolResult } from "./tool-types.ts";
import type { TurnState } from "./turn-state.ts";

type Built = {
  readonly scenario: ForecastScenario;
  readonly holdings: readonly ForecastHoldingView[];
  readonly overridden: ReadonlySet<number>;
  readonly unvalued: readonly string[];
};

const eur = (value: number): string => value.toFixed(2);
const percent = (value: number): string => (value * 100).toFixed(2);

const addMonths = (start: string, offset: number): string => {
  const [year = 0, month = 1] = start.split("-").map(Number);
  const at = year * 12 + (month - 1) + offset;
  return `${Math.floor(at / 12)}-${String((at % 12) + 1).padStart(2, "0")}`;
};

/** Whole cents by weight, floors first and the remainder to the last row, so rows sum to the total exactly. */
const splitCents = (totalEur: number, weights: readonly number[]): number[] => {
  const total = Math.round(totalEur * 100);
  const sum = weights.reduce((acc, weight) => acc + weight, 0);
  const shares = weights.map((weight) =>
    Math.floor(total * (sum > 0 ? weight / sum : 1 / weights.length) + 1e-9),
  );
  const rest = total - shares.slice(0, -1).reduce((acc, share) => acc + share, 0);
  return shares.map((share, index) => (index === shares.length - 1 ? rest : share) / 100);
};

const withPlan = (
  base: readonly ForecastContribution[],
  overrides: ForecastOverrides,
  holdings: readonly ForecastHoldingView[],
): ForecastContribution[] => {
  if (overrides.monthlyTotalEur !== undefined) {
    const rows =
      base.length > 0
        ? base
        : holdings.map((row) => ({
            holdingId: String(row.instrumentId),
            monthlyEur: row.valueEur,
          }));
    const amounts = splitCents(
      overrides.monthlyTotalEur,
      rows.map((row) => row.monthlyEur),
    );
    return rows
      .map((row, index) => ({ ...row, monthlyEur: amounts[index] ?? 0 }))
      .filter((row) => row.monthlyEur > 0);
  }
  const changed = overrides.plan ?? [];
  const replaced = new Set(changed.map((row) => String(row.instrumentId)));
  return [
    ...base.filter((row) => !replaced.has(row.holdingId)),
    ...changed
      .filter((row) => row.monthlyEur > 0)
      .map(({ instrumentId, ...row }) => ({ ...row, holdingId: String(instrumentId) })),
  ];
};

/** The caller's real forecast with the model's changes; every instrument id must be one of its holdings. */
const buildScenario = async (
  db: Db,
  userId: string,
  overrides: ForecastOverrides,
): Promise<Built> => {
  const report = await forecastFor(db, userId, {
    months: overrides.months,
    real: overrides.real,
    instrumentIds: overrides.holdingIds === undefined ? undefined : [...overrides.holdingIds],
  });
  const known = new Set(report.holdings.map((row) => row.instrumentId));
  const listed = report.holdings.map((row) => `${row.instrumentId} (${row.name})`).join(", ");
  const check = (id: number | undefined): void => {
    if (id !== undefined && !known.has(id)) {
      throw new Error(
        `Instrument ${id} is not in the owner's forecast. Its instruments: ${listed || "none"}`,
      );
    }
  };
  (overrides.holdingIds ?? []).forEach(check);
  if (report.holdings.length === 0) {
    throw new Error("There are no valued holdings or monthly plan rows to forecast");
  }
  [
    ...(overrides.plan ?? []).map((row) => row.instrumentId),
    ...(overrides.events ?? []).map((row) => row.instrumentId),
    ...(overrides.shocks ?? []).map((row) => row.instrumentId),
    ...(overrides.rates ?? []).flatMap((row) =>
      row.instrumentId === "all" ? [] : [row.instrumentId],
    ),
  ].forEach(check);

  const rateFor = (instrumentId: number): number | undefined =>
    (overrides.rates ?? [])
      .filter((row) => row.instrumentId === "all" || row.instrumentId === instrumentId)
      .at(-1)?.rate;
  const overridden = new Set(
    report.holdings.flatMap((row) =>
      rateFor(row.instrumentId) === undefined ? [] : [row.instrumentId],
    ),
  );
  const holdings = report.holdings.map((row) => ({
    ...row,
    rate: rateFor(row.instrumentId) ?? row.rate,
  }));
  const target = (id: number | undefined): string | null => (id === undefined ? null : String(id));
  const scenario = ForecastScenarioInput.parse({
    ...report.scenario,
    holdings: report.scenario.holdings.map((row) => ({
      ...row,
      rate: rateFor(Number(row.id)) ?? row.rate,
    })),
    contributions: withPlan(report.scenario.contributions ?? [], overrides, report.holdings),
    events: (overrides.events ?? []).map((row) => ({
      month: row.month,
      holdingId: target(row.instrumentId),
      amountEur: row.amountEur,
    })),
    shocks: (overrides.shocks ?? []).map((row) => ({
      month: row.month,
      holdingId: target(row.instrumentId),
      change: row.change,
    })),
  });
  return { scenario, holdings, overridden, unvalued: report.unvalued };
};

const nameOf = (built: Built, holdingId: string): string =>
  built.holdings.find((row) => String(row.instrumentId) === holdingId)?.name ?? holdingId;

/** Said with every result so the answer can state them. */
const assumptionsOf = (built: Built): ToolResult => {
  const { scenario } = built;
  const contributions = scenario.contributions ?? [];
  return {
    months: scenario.months,
    startMonth: scenario.startDate,
    endMonth: addMonths(scenario.startDate, scenario.months),
    real: scenario.real ?? true,
    inflationPercent: scenario.real === false ? null : percent(scenario.inflation ?? 0),
    monthlyPlanTotalEur: eur(contributions.reduce((sum, row) => sum + row.monthlyEur, 0)),
    plan: contributions.map((row) => ({
      instrumentId: Number(row.holdingId),
      name: nameOf(built, row.holdingId),
      monthlyEur: eur(row.monthlyEur),
      fromMonth: row.fromMonth ?? 1,
      toMonth: row.toMonth ?? scenario.months,
      yearlyIncreasePercent: percent(row.yearlyIncrease ?? 0),
    })),
    events: (scenario.events ?? []).length,
    shocks: (scenario.shocks ?? []).length,
    rates: built.holdings.map((row) => ({
      instrumentId: row.instrumentId,
      name: row.name,
      ratePercent: percent(row.rate),
      volatilityPercent: percent(row.volatility),
      basis: built.overridden.has(row.instrumentId) ? "chat-override" : row.basis,
      yearsOfHistory: Number(row.yearsOfHistory.toFixed(1)),
    })),
  };
};

const NOTE =
  "An estimate from past prices and the plan, not a promise. low/high are a rough 10-90 % range, " +
  "wider than the likely spread. real: true means today's euros (inflation removed). Rate basis: " +
  "history = measured from stored prices, blend = short history blended with a default, default = " +
  "a default for the instrument kind, user = the owner's own rate, chat-override = changed in this question. " +
  "startValueEur is today's holdings; newMoneyEur is money paid in after today. " +
  "State the rates and their basis, real or nominal, the months and the monthly plan.";

const summaryOf = (scenarioId: string, built: Built, result: ForecastResult): ToolResult => {
  const last = result.points.at(-1);
  return {
    scenarioId,
    assumptions: assumptionsOf(built),
    end: {
      expectedEur: eur(last?.total.expected ?? 0),
      lowEur: eur(last?.total.low ?? 0),
      highEur: eur(last?.total.high ?? 0),
    },
    startValueEur: eur(result.startValueEur),
    newMoneyEur: eur(last?.newMoneyEur ?? 0),
    holdings: built.holdings.map((row) => {
      const end = last?.holdings.find((holding) => holding.id === String(row.instrumentId));
      return {
        instrumentId: row.instrumentId,
        name: row.name,
        endExpectedEur: eur(end?.expected ?? 0),
        ratePercent: percent(row.rate),
        basis: built.overridden.has(row.instrumentId) ? "chat-override" : row.basis,
      };
    }),
    shortfallEur: eur(result.shortfalls.reduce((sum, row) => sum + row.shortfallEur, 0)),
    unvalued: [...built.unvalued],
    note: NOTE,
  };
};

const OVERRIDES_HELP =
  "All fields are optional changes to the owner's real forecast (holdings, monthly plan, rates): " +
  "months (1-600, default 120), real (default true: today's euros), holdingIds (only these instruments), " +
  "plan rows {instrumentId, monthlyEur, fromMonth?, toMonth?, yearlyIncrease?} replacing that instrument's " +
  "plan, OR monthlyTotalEur (the whole plan scaled to this total), events {month, instrumentId?, amountEur} " +
  "(negative = withdrawal; no instrumentId = spread by value), shocks {month, instrumentId?, change} " +
  '(-0.3 = a 30 % fall), rates {instrumentId | "all", rate} as yearly decimals (0.05 = 5 %). ' +
  "Instrument ids come from get_holdings, get_instruments or get_monthly_plan.";

export const buildForecastTools = (db: Db, userId: string, turn: TurnState): ChatTool[] => [
  {
    name: "run_forecast",
    description:
      "Forecasts the owner's portfolio month by month from their holdings, monthly plan and rates " +
      "measured from past prices. Returns a summary and a scenarioId for show_chart; call it several " +
      "times to compare scenarios. " +
      OVERRIDES_HELP,
    schema: RunForecastInput,
    run: async (input) => {
      const overrides = RunForecastInput.parse(input);
      const built = await buildScenario(db, userId, overrides);
      const result = forecast(built.scenario);
      const stored = turn.addScenario({
        holdings: built.holdings.map((row) => ({ instrumentId: row.instrumentId, name: row.name })),
        result,
      });
      return summaryOf(stored.id, built, result);
    },
  },
  {
    name: "forecast_target",
    description:
      "When the owner's portfolio reaches targetEur on the expected path (monthsToReach, null beyond " +
      "50 years), and with byMonth also the extra euros per month needed to reach it by that month. " +
      OVERRIDES_HELP,
    schema: ForecastTargetInput,
    run: async (input) => {
      const { targetEur, byMonth, ...overrides } = ForecastTargetInput.parse(input);
      const built = await buildScenario(db, userId, overrides);
      const reach = monthsToReach(built.scenario, targetEur);
      const needed =
        byMonth === undefined ? null : monthlyNeeded(built.scenario, targetEur, byMonth);
      return {
        targetEur: eur(targetEur),
        monthsToReach: reach,
        reachedMonth: reach === null ? null : addMonths(built.scenario.startDate, reach),
        monthlyNeeded:
          needed === null
            ? null
            : {
                byMonth: byMonth ?? null,
                byMonthLabel:
                  byMonth === undefined ? null : addMonths(built.scenario.startDate, byMonth),
                extraMonthlyEur: eur(needed.extraMonthlyEur),
                rows: needed.rows.map((row) => ({
                  instrumentId: Number(row.holdingId),
                  name: nameOf(built, row.holdingId),
                  extraMonthlyEur: eur(row.extraMonthlyEur),
                })),
              },
        assumptions: assumptionsOf(built),
        note: `${NOTE} monthsToReach counts from today on the expected path; monthlyNeeded is null when the target is out of reach or byMonth was not given.`,
      };
    },
  },
];

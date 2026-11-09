import { describe, expect, test } from "vitest";

import {
  forecast,
  monthlyNeeded,
  monthsToReach,
  type ForecastHolding,
  type ForecastScenario,
} from "./forecast.ts";

const holding = (over: Partial<ForecastHolding> = {}): ForecastHolding => ({
  id: "a",
  name: "Alpha",
  valueEur: 10_000,
  rate: 0.06,
  volatility: 0,
  ...over,
});

const nominal = (over: Partial<ForecastScenario> = {}): ForecastScenario => ({
  startDate: "2026-11",
  months: 120,
  holdings: [holding()],
  real: false,
  ...over,
});

const last = (scenario: ForecastScenario) => {
  const points = forecast(scenario).points;
  const point = points[points.length - 1];
  if (point === undefined) throw new Error("no points");
  return point;
};

describe("forecast", () => {
  test("no growth and no contributions stay flat", () => {
    const points = forecast(nominal({ holdings: [holding({ rate: 0 })] })).points;
    expect(points).toHaveLength(121);
    expect(points.every((point) => point.total.expected === 10_000)).toBe(true);
  });

  test("contributions alone add up to their sum", () => {
    const end = last(
      nominal({
        months: 24,
        holdings: [holding({ valueEur: 0, rate: 0 })],
        contributions: [{ holdingId: "a", monthlyEur: 150.5 }],
      }),
    );
    expect(end.total.expected).toBe(3612);
    expect(end.newMoneyEur).toBe(3612);
  });

  test("new money is deflated at each payment's own month; today's value is kept apart", () => {
    const result = forecast(
      nominal({
        real: true,
        inflation: 0.02,
        holdings: [holding({ valueEur: 0, rate: 0 }), holding({ id: "b", valueEur: 250, rate: 0 })],
        contributions: [{ holdingId: "a", monthlyEur: 100 }],
      }),
    );
    const end = result.points[120];
    expect(result.startValueEur).toBe(250);
    expect(end?.holdings[0]?.expected).toBe(9844.18);
    expect(end?.newMoneyEur).toBe(10_877.56);
  });

  test("within a month: growth first, contributions at month end", () => {
    const end = last(
      nominal({
        months: 12,
        holdings: [holding({ valueEur: 0 })],
        contributions: [{ holdingId: "a", monthlyEur: 100 }],
      }),
    );
    expect(end.total.expected).toBe(1232.65);
  });

  test("6 % a year for 10 years on 10 000 is 17 908.48 nominal", () => {
    expect(last(nominal()).total.expected).toBe(17_908.48);
  });

  test("today's euros divide by (1 + inflation) ^ years", () => {
    expect(last(nominal({ real: true, inflation: 0.02 })).total.expected).toBe(14_691.19);
    // Default is today's euros at 2 %.
    const { real: _real, ...defaults } = nominal();
    expect(last(defaults).total.expected).toBe(14_691.19);
  });

  test("labels months from the start date", () => {
    const points = forecast(nominal({ months: 3 })).points;
    expect(points.map((point) => point.month)).toEqual([
      "2026-11",
      "2026-12",
      "2027-01",
      "2027-02",
    ]);
  });

  test("the band is the lognormal 10th and 90th percentile", () => {
    const end = last(nominal({ months: 12, holdings: [holding({ volatility: 0.2 })] }));
    expect(end.total).toEqual({ low: 8040.84, expected: 10_600, high: 13_425.74 });
  });

  test("each contribution is its own tranche in the band", () => {
    const end = last(
      nominal({
        months: 24,
        holdings: [holding({ valueEur: 1000, volatility: 0.2 })],
        events: [{ month: 12, holdingId: "a", amountEur: 100 }],
      }),
    );
    expect(end.total.expected).toBe(1229.6);
    expect(end.total.low).toBe(831.71);
  });

  test("low <= expected <= high every month, even at high volatility", () => {
    const points = forecast(
      nominal({
        months: 600,
        holdings: [holding({ volatility: 0.6 }), holding({ id: "b", volatility: 0.1 })],
        contributions: [{ holdingId: "a", monthlyEur: 100 }],
      }),
    ).points;
    for (const point of points) {
      expect(point.total.low).toBeLessThanOrEqual(point.total.expected);
      expect(point.total.expected).toBeLessThanOrEqual(point.total.high);
    }
  });

  test("zero volatility makes all three paths equal", () => {
    const point = last(nominal({ contributions: [{ holdingId: "a", monthlyEur: 50 }] }));
    expect(point.total.low).toBe(point.total.expected);
    expect(point.total.high).toBe(point.total.expected);
  });

  test("yearly increase raises a contribution once every 12 months", () => {
    const end = last(
      nominal({
        months: 24,
        holdings: [holding({ valueEur: 0, rate: 0 })],
        contributions: [{ holdingId: "a", monthlyEur: 100, yearlyIncrease: 0.1 }],
      }),
    );
    expect(end.total.expected).toBe(12 * 100 + 12 * 110);
  });

  test("a contribution window limits the months it pays in", () => {
    const end = last(
      nominal({
        months: 12,
        holdings: [holding({ valueEur: 0, rate: 0 })],
        contributions: [{ holdingId: "a", monthlyEur: 100, fromMonth: 3, toMonth: 5 }],
      }),
    );
    expect(end.total.expected).toBe(300);
  });

  test("an event changes the path from its month on", () => {
    const flat = nominal({ months: 6, holdings: [holding({ rate: 0 })] });
    const points = forecast({
      ...flat,
      events: [{ month: 3, holdingId: "a", amountEur: 500 }],
    }).points;
    expect(points.map((point) => point.total.expected)).toEqual([
      10_000, 10_000, 10_000, 10_500, 10_500, 10_500, 10_500,
    ]);
  });

  test("a shock changes the path from its month on", () => {
    const flat = nominal({ months: 4, holdings: [holding({ rate: 0 })] });
    const points = forecast({
      ...flat,
      shocks: [{ month: 2, holdingId: null, change: -0.5 }],
    }).points;
    expect(points.map((point) => point.total.expected)).toEqual([10_000, 10_000, 5000, 5000, 5000]);
  });

  test("a withdrawal larger than the holding is capped and the shortfall reported", () => {
    const result = forecast(
      nominal({
        months: 3,
        holdings: [holding({ rate: 0, valueEur: 1000 })],
        events: [{ month: 2, holdingId: "a", amountEur: -1500 }],
      }),
    );
    expect(result.points.map((point) => point.total.expected)).toEqual([1000, 1000, 0, 0]);
    expect(result.shortfalls).toEqual([{ month: 2, holdingId: "a", shortfallEur: 500 }]);
  });

  test("an event with no holding is spread pro rata", () => {
    const result = forecast(
      nominal({
        months: 1,
        holdings: [
          holding({ rate: 0, valueEur: 3000 }),
          holding({ id: "b", rate: 0, valueEur: 1000 }),
        ],
        events: [{ month: 1, holdingId: null, amountEur: -2000 }],
      }),
    );
    expect(result.points[1]?.holdings.map((row) => row.expected)).toEqual([1500, 500]);
  });
});

describe("solvers", () => {
  test("monthsToReach agrees with forecast", () => {
    const scenario = nominal({ contributions: [{ holdingId: "a", monthlyEur: 200 }] });
    const month = monthsToReach(scenario, 20_000);
    expect(month).not.toBeNull();
    const points = forecast({ ...scenario, months: 600 }).points;
    expect(points[month ?? 0]?.total.expected).toBeGreaterThanOrEqual(20_000);
    expect(points[(month ?? 0) - 1]?.total.expected).toBeLessThan(20_000);
  });

  test("monthsToReach is null when the target is out of reach", () => {
    expect(monthsToReach(nominal({ holdings: [holding({ rate: 0 })] }), 20_000)).toBeNull();
  });

  test("monthsToReach on the low path takes longer", () => {
    const scenario = nominal({ holdings: [holding({ volatility: 0.1 })] });
    expect(monthsToReach(scenario, 20_000, "low") ?? 0).toBeGreaterThan(
      monthsToReach(scenario, 20_000) ?? 0,
    );
  });

  test("monthlyNeeded with no rows is one total figure that just reaches the target", () => {
    const scenario = nominal({ holdings: [holding({ rate: 0 })] });
    const needed = monthlyNeeded(scenario, 22_000, 120);
    expect(needed?.extraMonthlyEur).toBe(100);
  });

  test("monthlyNeeded round-trips through forecast, to the cent", () => {
    const scenario = nominal({
      holdings: [holding(), holding({ id: "b", valueEur: 2000, rate: 0.03 })],
      contributions: [
        { holdingId: "a", monthlyEur: 300 },
        { holdingId: "b", monthlyEur: 100 },
      ],
    });
    const needed = monthlyNeeded(scenario, 100_000, 120);
    if (needed === null) throw new Error("expected an answer");
    const withExtra = (extras: readonly { holdingId: string; extraMonthlyEur: number }[]) => ({
      ...scenario,
      contributions: [
        ...(scenario.contributions ?? []),
        ...extras.map((row) => ({ holdingId: row.holdingId, monthlyEur: row.extraMonthlyEur })),
      ],
    });
    expect(last(withExtra(needed.rows)).total.expected).toBeGreaterThanOrEqual(100_000);
    const shy = needed.rows.map((row) => ({ ...row, extraMonthlyEur: row.extraMonthlyEur - 0.01 }));
    expect(last(withExtra(shy)).total.expected).toBeLessThan(100_000);
    // Pro rata to the existing rows: 3 to 1.
    expect(needed.rows.map((row) => row.holdingId)).toEqual(["a", "b"]);
    expect(
      Math.abs((needed.rows[0]?.extraMonthlyEur ?? 0) - 3 * (needed.rows[1]?.extraMonthlyEur ?? 0)),
    ).toBeLessThan(0.05);
  });

  test("monthlyNeeded refuses a byMonth outside 1…600", () => {
    expect(() => monthlyNeeded(nominal(), 5000, 0)).toThrow("byMonth must be between 1 and 600");
    expect(() => monthlyNeeded(nominal(), 5000, 601)).toThrow("byMonth must be between 1 and 600");
  });

  test("monthlyNeeded is 0 when the target is already reached", () => {
    expect(monthlyNeeded(nominal(), 5000, 12)?.extraMonthlyEur).toBe(0);
  });
});

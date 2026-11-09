import { beforeAll, describe, expect, test } from "vitest";
import { z } from "zod";

import { EUR } from "../../core/money.ts";
import { monthsToReach } from "../../core/forecast.ts";
import { openAccount } from "../accounts.ts";
import { CreateAccount } from "../action-inputs.ts";
import { db } from "../db/index.ts";
import { prices, transactions } from "../db/schema.ts";
import { addInstrument } from "../instruments/store.ts";
import { ChartSpecSchema, ChatChartSchema } from "./chart-schema.ts";
import { RunForecastInput, ForecastTargetInput } from "./forecast-overrides.ts";
import type { ChartTool, ChatTool, ToolArgs } from "./tool-types.ts";

// Forecast and chart tools: the numbers come from the caller's own data and the engine, never from the model.

let auth: ReturnType<(typeof import("../auth.ts"))["getAuth"]>;
let forecastTools: typeof import("./tools-forecast.ts");
let chartTools: typeof import("./tools-chart.ts");
let turns: typeof import("./turn-state.ts");

beforeAll(async () => {
  auth = (await import("../auth.ts")).getAuth();
  forecastTools = await import("./tools-forecast.ts");
  chartTools = await import("./tools-chart.ts");
  turns = await import("./turn-state.ts");
});

const signUp = async (): Promise<string> => {
  const response = await auth.handler(
    new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Test User",
        email: `chat-forecast-${crypto.randomUUID()}@example.com`,
        password: "correct horse battery staple",
      }),
    }),
  );
  if (response.status !== 200) throw new Error(`sign-up failed with status ${response.status}`);
  // SAFETY: a 200 from POST /sign-up/email carries `{ user: { id } }`.
  const body = (await response.json()) as { user: { id: string } };
  return body.user.id;
};

const isin = (): string => `FI${crypto.randomUUID().replace(/-/g, "").toUpperCase().slice(0, 9)}0`;

const instrument = async (name: string): Promise<number> =>
  (
    await addInstrument(db, {
      isin: isin(),
      ticker: null,
      name,
      kind: "fund",
      currency: EUR,
      priceSource: "manual",
    })
  ).id;

const txn = (accountId: number, values: Partial<typeof transactions.$inferInsert>) =>
  db
    .insert(transactions)
    .values({
      accountId,
      instrumentId: null,
      type: "BUY",
      tradeDate: "2024-01-10",
      quantity: 0,
      unitPrice: null,
      amount: 0,
      fee: 0,
      tax: 0,
      currency: EUR,
      fxRateEur: 100_000_000,
      contentHash: crypto.randomUUID(),
      ...values,
    })
    .run();

const price = (instrumentId: number, date: string, close: number) =>
  db
    .insert(prices)
    .values({ instrumentId, date, close, currency: EUR, source: "manual", fetchedAt: new Date() })
    .onConflictDoNothing()
    .run();

/** A user holding 10 units at 100 €: worth 1 000 € today. */
const holder = async (): Promise<{ userId: string; instrumentId: number }> => {
  const userId = await signUp();
  const accountId = (
    await openAccount(db, userId, CreateAccount.parse({ name: "Nordnet", broker: "nordnet" }))
  ).id;
  const instrumentId = await instrument("Index fund");
  await txn(accountId, { instrumentId, quantity: 10_000_000, amount: -1000_00 });
  await price(instrumentId, "2024-01-10", 100_00);
  await price(instrumentId, "2024-06-03", 100_00);
  return { userId, instrumentId };
};

type Tools = { run: ChatTool; target: ChatTool; chart: ChartTool };

const toolsFor = (userId: string, turn = turns.createTurnState()): Tools => {
  const [run, target] = forecastTools.buildForecastTools(db, userId, turn);
  if (run === undefined || target === undefined) throw new Error("Forecast tools missing");
  return { run, target, chart: chartTools.buildChartTool(db, userId, turn) };
};

const FLAT = { months: 12, real: false, rates: [{ instrumentId: "all" as const, rate: 0 }] };

const Summary = z.object({
  scenarioId: z.string(),
  end: z.object({ expectedEur: z.string(), lowEur: z.string(), highEur: z.string() }),
  startValueEur: z.string(),
  newMoneyEur: z.string(),
  assumptions: z
    .object({ months: z.number(), real: z.boolean(), monthlyPlanTotalEur: z.string() })
    .loose(),
  holdings: z.array(
    z.object({
      instrumentId: z.number(),
      ratePercent: z.string(),
      basis: z.string(),
      endExpectedEur: z.string(),
    }),
  ),
});

const summary = async (tool: ChatTool, input: ToolArgs) => Summary.parse(await tool.run(input));

describe("run_forecast", () => {
  test("runs the caller's own holdings with the overrides, and states its assumptions", async () => {
    const { userId, instrumentId } = await holder();
    const { run } = toolsFor(userId);
    const flat = await summary(run, FLAT);
    expect(flat.scenarioId).toMatch(/^S\d+$/);
    expect(flat.end.expectedEur).toBe("1000.00");
    expect(flat.startValueEur).toBe("1000.00");
    expect(flat.newMoneyEur).toBe("0.00");
    expect(flat.assumptions).toMatchObject({ months: 12, real: false });
    expect(flat.holdings).toEqual([
      expect.objectContaining({ instrumentId, ratePercent: "0.00", basis: "chat-override" }),
    ]);
  });

  test("a monthly total, an event, a shock and a rate each change the result as the engine says", async () => {
    const { userId, instrumentId } = await holder();
    const { run } = toolsFor(userId);
    const total = await summary(run, { ...FLAT, monthlyTotalEur: 100 });
    expect(total.end.expectedEur).toBe("2200.00");
    expect(total.newMoneyEur).toBe("1200.00");
    expect(total.assumptions.monthlyPlanTotalEur).toBe("100.00");

    const event = await summary(run, { ...FLAT, events: [{ month: 6, amountEur: 500 }] });
    expect(event.end.expectedEur).toBe("1500.00");

    const shock = await summary(run, {
      ...FLAT,
      shocks: [{ month: 1, instrumentId, change: -0.5 }],
    });
    expect(shock.end.expectedEur).toBe("500.00");

    const rate = await summary(run, { ...FLAT, rates: [{ instrumentId, rate: 0.1 }] });
    expect(rate.end.expectedEur).toBe("1100.00");
    expect(rate.holdings[0]?.ratePercent).toBe("10.00");
  });

  test("refuses an instrument that is not in the caller's forecast", async () => {
    const { userId } = await holder();
    const other = await holder();
    const { run } = toolsFor(userId);
    const foreign = other.instrumentId;
    await expect(run.run({ ...FLAT, holdingIds: [foreign] })).rejects.toThrow(/not in/);
    await expect(run.run({ ...FLAT, rates: [{ instrumentId: foreign, rate: 0 }] })).rejects.toThrow(
      /not in/,
    );
    await expect(
      run.run({ ...FLAT, plan: [{ instrumentId: foreign, monthlyEur: 10 }] }),
    ).rejects.toThrow(/not in/);
    await expect(
      run.run({ ...FLAT, events: [{ month: 1, instrumentId: foreign, amountEur: 10 }] }),
    ).rejects.toThrow(/not in/);
  });

  test.each([
    ["too long a horizon", { months: 601 }],
    ["too many events", { events: Array.from({ length: 21 }, () => ({ month: 1, amountEur: 1 })) }],
    ["too many shocks", { shocks: Array.from({ length: 21 }, () => ({ month: 1, change: -0.1 })) }],
    ["a rate above 100 %", { rates: [{ instrumentId: "all", rate: 1.5 }] }],
    ["a rate below −90 %", { rates: [{ instrumentId: "all", rate: -0.95 }] }],
    ["an amount above 10 000 000", { monthlyTotalEur: 10_000_001 }],
    ["plan rows and a total at once", { monthlyTotalEur: 1, plan: [] }],
    ["an unknown field", { data: [1, 2] }],
  ])("refuses %s", (_name, input) => {
    expect(RunForecastInput.safeParse(input).success).toBe(false);
  });
});

describe("forecast_target", () => {
  test("round-trips with the engine", async () => {
    const { userId } = await holder();
    const { run, target } = toolsFor(userId);
    const reach = await target.run({ ...FLAT, monthlyTotalEur: 100, targetEur: 2200 });
    const engine = monthsToReach(
      {
        startDate: "2026-11",
        months: 12,
        holdings: [{ id: "a", name: "A", valueEur: 1000, rate: 0, volatility: 0.15 }],
        contributions: [{ holdingId: "a", monthlyEur: 100 }],
        real: false,
      },
      2200,
    );
    expect(reach).toMatchObject({ monthsToReach: engine });
    expect(engine).toBe(12);

    const needed = await target.run({ ...FLAT, targetEur: 2200, byMonth: 12 });
    expect(needed).toMatchObject({ monthlyNeeded: { extraMonthlyEur: "100.00" } });
    const check = await summary(run, { ...FLAT, monthlyTotalEur: 100 });
    expect(Number(check.end.expectedEur)).toBeGreaterThanOrEqual(2200);
  });

  test("refuses a target above the cap", () => {
    expect(ForecastTargetInput.safeParse({ targetEur: 2e7 }).success).toBe(false);
  });
});

const spec = (series: ToolArgs["series"], extra: Partial<ToolArgs> = {}): ToolArgs => ({
  title: "Test chart",
  kind: "line",
  yUnit: "EUR",
  series,
  ...extra,
});

describe("show_chart", () => {
  test("charts two scenarios of one turn together, from the engine's numbers", async () => {
    const { userId } = await holder();
    const { run, chart } = toolsFor(userId);
    const a = await summary(run, FLAT);
    const b = await summary(run, { ...FLAT, monthlyTotalEur: 100 });
    const shown = await chart.chart(
      spec([
        { source: "forecast", scenarioId: a.scenarioId, path: "expected" },
        { source: "forecast", scenarioId: b.scenarioId, path: "expected" },
      ]),
    );
    expect(ChatChartSchema.parse(shown)).toEqual(shown);
    expect(shown.data.series.map((series) => series.points.length)).toEqual([13, 13]);
    expect(shown.data.series.map((series) => series.points.at(-1)?.y)).toEqual([1000, 2200]);
    expect(shown.spec.title).toBe("Test chart");
  });

  test("refuses a scenario id from another turn or one the model invented", async () => {
    const { userId } = await holder();
    const first = toolsFor(userId);
    const { scenarioId } = await summary(first.run, FLAT);
    const second = toolsFor(userId);
    await expect(
      second.chart.chart(spec([{ source: "forecast", scenarioId, path: "expected" }])),
    ).rejects.toThrow(/Unknown scenario/);
    await expect(
      first.chart.chart(spec([{ source: "forecast", scenarioId: "S99", path: "low" }])),
    ).rejects.toThrow(/Unknown scenario/);
  });

  test("value series and allocation come from the caller's own ledger, capped at 400 points", async () => {
    const { userId } = await holder();
    const stranger = await signUp();
    const { chart } = toolsFor(userId);
    const value = await chart.chart(spec([{ source: "value-series", range: "max" }]));
    const points = value.data.series[0]?.points ?? [];
    expect(points.length).toBeGreaterThan(100);
    expect(points.length).toBeLessThanOrEqual(400);
    expect(points.at(-1)?.y).toBe(1000);

    const theirs = await toolsFor(stranger).chart.chart(
      spec([{ source: "value-series", range: "max" }]),
    );
    expect(theirs.data.series[0]?.points.every((point) => point.y === 0)).toBe(true);

    const allocation = await chart.chart(
      spec([{ source: "allocation", dimension: "kind" }], { kind: "bar", yUnit: "%" }),
    );
    expect(allocation.data.series[0]?.points).toEqual([{ x: "Funds", y: 100 }]);
  });

  test("holding price is only for the caller's own instruments", async () => {
    const { userId, instrumentId } = await holder();
    const other = await holder();
    const { chart } = toolsFor(userId);
    const own = await chart.chart(spec([{ source: "holding-price", instrumentId, range: "max" }]));
    expect(own.data.series[0]?.points).toEqual([
      { x: "2024-01-10", y: 100 },
      { x: "2024-06-03", y: 100 },
    ]);
    await expect(
      chart.chart(
        spec([{ source: "holding-price", instrumentId: other.instrumentId, range: "max" }]),
      ),
    ).rejects.toThrow(/Instrument not found/);
  });

  test("spending by month by category, from the caller's bank rows only", async () => {
    const userId = await signUp();
    const bank = (
      await openAccount(
        db,
        userId,
        CreateAccount.parse({ name: "OP", broker: "op", kind: "bank", accountType: "current" }),
      )
    ).id;
    const thisMonth = new Date().toISOString().slice(0, 7);
    await txn(bank, {
      type: "WITHDRAWAL",
      tradeDate: `${thisMonth}-01`,
      amount: -4215,
      note: "PKORTTIMAKSU — K-MARKET EXAMPLE",
    });
    const { chart } = toolsFor(userId);
    const groceries = await chart.chart(
      spec([{ source: "spending-by-month", categoryId: "groceries", months: 3 }], { kind: "bar" }),
    );
    const series = groceries.data.series[0];
    expect(series?.label).toBe("Groceries");
    expect(series?.points).toHaveLength(3);
    expect(series?.points.at(-1)).toEqual({ x: thisMonth, y: 42.15 });

    const all = await chart.chart(spec([{ source: "spending-by-month", months: 1 }]));
    expect(all.data.series[0]?.points).toEqual([{ x: thisMonth, y: 42.15 }]);

    const stranger = await toolsFor(await signUp()).chart.chart(
      spec([{ source: "spending-by-month", months: 1 }]),
    );
    expect(stranger.data.series[0]?.points).toEqual([{ x: thisMonth, y: 0 }]);

    await expect(
      chart.chart(spec([{ source: "spending-by-month", categoryId: "nope", months: 1 }])),
    ).rejects.toThrow(/Unknown category/);
  });

  test("refuses a unit that does not match the data", async () => {
    const { userId } = await holder();
    const { chart } = toolsFor(userId);
    await expect(
      chart.chart(spec([{ source: "value-series", range: "1y" }], { yUnit: "%" })),
    ).rejects.toThrow(/unit/);
  });

  test("at most ten charts in one turn", async () => {
    const { userId } = await holder();
    const { chart } = toolsFor(userId);
    const one = spec([{ source: "allocation", dimension: "kind" }], { yUnit: "%" });
    for (let index = 0; index < 10; index++) await chart.chart(one);
    await expect(chart.chart(one)).rejects.toThrow(/ten charts/);
  });

  test("styles, transforms, a band and annotations: values still come from the app", async () => {
    const { userId } = await holder();
    const { run, chart } = toolsFor(userId);
    const flat = await summary(run, { ...FLAT, monthlyTotalEur: 100 });
    const shown = await chart
      .chart(
        spec(
          [
            {
              source: "forecast",
              scenarioId: flat.scenarioId,
              path: "expected",
              kind: "line",
              label: "Expected",
              color: "#2a78d6",
              width: 3,
              dash: "dashed",
              curve: "smooth",
              points: true,
            },
            {
              source: "forecast",
              scenarioId: flat.scenarioId,
              path: "contributed",
              kind: "bar",
              color: 3,
              axis: "right",
              transform: "index-100",
              stack: "money",
            },
          ],
          {
            subtitle: "Plan of 100 a month",
            yScale: "linear",
            yFormat: "compact-EUR",
            legend: "bottom",
            height: 360,
            band: { scenarioId: flat.scenarioId, label: "Range" },
            annotations: [{ type: "y-line", y: 2000, label: "Goal" }],
          },
        ),
      )
      .catch((cause: unknown) => cause);
    // Contributed starts at 0, so index-100 is refused rather than drawn from a zero base.
    expect(shown).toBeInstanceOf(Error);

    const ok = await chart.chart(
      spec(
        [
          {
            source: "forecast",
            scenarioId: flat.scenarioId,
            path: "expected",
            transform: "index-100",
          },
          { source: "forecast", scenarioId: flat.scenarioId, path: "contributed", axis: "right" },
        ],
        { yUnit: "index" },
      ),
    );
    expect(ok.data.series.map((row) => [row.label, row.unit, row.points.at(-1)?.y])).toEqual([
      ["S1 expected, indexed to 100", "index", 220],
      ["S1 new money put in", "EUR", 1200],
    ]);

    const banded = await chart.chart(
      spec([{ source: "forecast", scenarioId: flat.scenarioId, path: "expected" }], {
        band: { scenarioId: flat.scenarioId },
      }),
    );
    expect(banded.data.band?.points).toHaveLength(13);
    expect(banded.data.band?.points.at(-1)?.low).toBeLessThanOrEqual(2200);
  });

  test("a band is refused unless the chart is in plain euros", async () => {
    const { userId } = await holder();
    const { run, chart } = toolsFor(userId);
    const { scenarioId } = await summary(run, FLAT);
    const expected = { source: "forecast" as const, scenarioId, path: "expected" as const };
    await expect(
      chart.chart(
        spec([{ ...expected, transform: "index-100" }], { yUnit: "index", band: { scenarioId } }),
      ),
    ).rejects.toThrow(/yUnit EUR/);
    await expect(
      chart.chart(
        spec([expected, { ...expected, transform: "index-100", axis: "right" }], {
          band: { scenarioId },
        }),
      ),
    ).rejects.toThrow(/transformed/);
  });

  test("cumulative is only for amounts per month, and summed before thinning", async () => {
    const { userId } = await holder();
    const { chart } = toolsFor(userId);
    await expect(
      chart.chart(spec([{ source: "value-series", range: "1y", transform: "cumulative" }])),
    ).rejects.toThrow(/only for spending-by-month/);
    const sums = await chart.chart(
      spec([{ source: "spending-by-month", months: 2, transform: "cumulative" }]),
    );
    expect(sums.data.series[0]?.label).toBe("All spending, cumulative");
  });

  test("a change from a start of zero is shown as is, with a note", async () => {
    const { chart } = toolsFor(await signUp());
    const shown = await chart.chart(
      spec([{ source: "value-series", range: "1y", transform: "percent-change-from-start" }], {
        yUnit: "EUR",
      }),
    );
    expect(shown.data.series[0]?.label).toBe("Portfolio value");
    expect(shown.data.notes.join(" ")).toMatch(/at or below zero/);
  });

  test("y bounds may widen the axis but never hide a value", async () => {
    const { userId } = await holder();
    const { chart } = toolsFor(userId);
    const value = { source: "value-series" as const, range: "1y" as const };
    const wide = await chart.chart(spec([value], { yMin: 0, yMax: 5000 }));
    expect([wide.spec.yMin, wide.spec.yMax, wide.data.notes]).toEqual([0, 5000, []]);
    const clipped = await chart.chart(spec([value], { yMin: 0, yMax: 500 }));
    expect([clipped.spec.yMin, clipped.spec.yMax]).toEqual([undefined, undefined]);
    expect(clipped.data.notes.join(" ")).toMatch(/would hide some values/);
    expect(ChartSpecSchema.safeParse(spec([value], { yMin: 5, yMax: 5 })).success).toBe(false);
  });

  test("allocation does not share an axis with time series", async () => {
    const { userId } = await holder();
    await expect(
      toolsFor(userId).chart.chart(
        spec([
          { source: "value-series", range: "1y" },
          { source: "allocation", dimension: "kind" },
        ]),
      ),
    ).rejects.toThrow(/by category, not time/);
  });

  test("days valued at cost are marked and counted for the model", async () => {
    const userId = await signUp();
    const accountId = (
      await openAccount(db, userId, CreateAccount.parse({ name: "Nordnet", broker: "nordnet" }))
    ).id;
    const instrumentId = await instrument("Unpriced fund");
    const start = new Date(Date.now() - 20 * 86_400_000).toISOString().slice(0, 10);
    const priced = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10);
    await txn(accountId, {
      instrumentId,
      tradeDate: start,
      quantity: 10_000_000,
      amount: -1000_00,
    });
    await price(instrumentId, priced, 100_00);
    await price(instrumentId, new Date().toISOString().slice(0, 10), 100_00);
    const shown = await toolsFor(userId).chart.chart(
      spec([{ source: "value-series", range: "3m" }]),
    );
    const points = shown.data.series[0]?.points ?? [];
    expect(points.some((point) => point.estimated === true)).toBe(true);
    expect(points.at(-1)?.estimated).toBe(false);
    const { chartSummary } = await import("./chart-schema.ts");
    expect(chartSummary(shown).series[0]?.estimatedPoints).toBeGreaterThan(0);
  });

  test("a log scale with a value at or below zero falls back to linear, with a note", async () => {
    const stranger = await signUp();
    const { chart } = toolsFor(stranger);
    const shown = await chart.chart(
      spec([{ source: "value-series", range: "1y" }], { yScale: "log" }),
    );
    expect(shown.data.yScale).toBe("linear");
    expect(shown.data.notes.join(" ")).toMatch(/linear/);

    const own = await holder();
    const log = await toolsFor(own.userId).chart.chart(
      spec([{ source: "holding-price", instrumentId: own.instrumentId, range: "max" }], {
        yScale: "log",
      }),
    );
    expect(log.data.yScale).toBe("log");
    expect(log.data.notes).toEqual([]);
  });

  test("right-axis series share one unit; left-axis series match yUnit", async () => {
    const { userId, instrumentId } = await holder();
    const { chart } = toolsFor(userId);
    await expect(
      chart.chart(
        spec([
          { source: "value-series", range: "1y" },
          { source: "spending-by-month", months: 3, axis: "right" },
          {
            source: "holding-price",
            instrumentId,
            range: "1y",
            axis: "right",
            transform: "index-100",
          },
        ]),
      ),
    ).rejects.toThrow(/right axis/);
  });

  test.each([
    ["red; background:url(x)"],
    ["var(--x)"],
    ["javascript:alert(1)"],
    ["#12"],
    ["rgb(1,2,3)"],
  ])("refuses the colour %s", (color) => {
    const valid = spec([{ source: "value-series", range: "1y", color }]);
    expect(ChartSpecSchema.safeParse(valid).success).toBe(false);
    expect(
      ChartSpecSchema.safeParse({
        ...spec([{ source: "value-series", range: "1y" }]),
        annotations: [{ type: "y-line", y: 1, label: "x", color }],
      }).success,
    ).toBe(false);
  });

  test("at most ten annotations, each label at most 40 characters", () => {
    const base = spec([{ source: "value-series", range: "1y" }]);
    const line = { type: "x-line", x: "2026-01", label: "Event" };
    expect(ChartSpecSchema.safeParse({ ...base, annotations: Array(10).fill(line) }).success).toBe(
      true,
    );
    expect(ChartSpecSchema.safeParse({ ...base, annotations: Array(11).fill(line) }).success).toBe(
      false,
    );
    expect(
      ChartSpecSchema.safeParse({ ...base, annotations: [{ ...line, label: "x".repeat(41) }] })
        .success,
    ).toBe(false);
  });

  test("the spec has no place for data points and at most six series", () => {
    const valid = spec([{ source: "value-series", range: "1y" }]);
    expect(ChartSpecSchema.safeParse(valid).success).toBe(true);
    expect(ChartSpecSchema.safeParse({ ...valid, data: [{ x: "a", y: 1 }] }).success).toBe(false);
    expect(
      ChartSpecSchema.safeParse({
        ...valid,
        series: [{ source: "value-series", range: "1y", points: [{ x: "a", y: 1 }] }],
      }).success,
    ).toBe(false);
    expect(
      ChartSpecSchema.safeParse({
        ...valid,
        series: Array.from({ length: 7 }, () => ({ source: "value-series", range: "1y" })),
      }).success,
    ).toBe(false);
    expect(ChartSpecSchema.safeParse({ ...valid, title: "x".repeat(121) }).success).toBe(false);
    expect(ChartSpecSchema.safeParse({ ...valid, note: "x".repeat(301) }).success).toBe(false);
  });
});

describe("ForecastTargetInput", () => {
  test("refuses byMonth outside 1…600 and a plan row ending before it starts, saying why", () => {
    const messages = (input: Partial<z.input<typeof ForecastTargetInput>>) =>
      ForecastTargetInput.safeParse({ targetEur: 1000, ...input }).error?.issues.map(
        (issue) => issue.message,
      );
    expect(messages({ byMonth: 0 })).toContain("byMonth must be between 1 and 600");
    expect(messages({ byMonth: 601 })).toContain("byMonth must be between 1 and 600");
    expect(
      messages({ plan: [{ instrumentId: 1, monthlyEur: 10, fromMonth: 6, toMonth: 2 }] }),
    ).toContain("toMonth must not be before fromMonth");
  });
});

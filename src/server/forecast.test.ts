import { beforeAll, describe, expect, test } from "vitest";

import { EUR } from "../core/money.ts";
import { db } from "./db/index.ts";
import { accounts, instruments, prices, transactions } from "./db/schema.ts";

let auth: ReturnType<(typeof import("./auth.ts"))["getAuth"]>;
let service: typeof import("./forecast.ts");
let plan: typeof import("./monthly-plan.ts");
let rates: typeof import("./forecast-rates.ts");

beforeAll(async () => {
  auth = (await import("./auth.ts")).getAuth();
  service = await import("./forecast.ts");
  plan = await import("./monthly-plan.ts");
  rates = await import("./forecast-rates.ts");
});

const signUp = async (): Promise<string> => {
  const response = await auth.handler(
    new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Test User",
        email: `forecast-${crypto.randomUUID()}@example.com`,
        password: "correct horse battery staple",
      }),
    }),
  );
  if (response.status !== 200) throw new Error(`sign-up failed with status ${response.status}`);
  // SAFETY: a 200 from POST /sign-up/email carries `{ user: { id } }`.
  const body = (await response.json()) as { user: { id: string } };
  return body.user.id;
};

const makeInstrument = async (name: string): Promise<number> => {
  const isin = `XX${crypto.randomUUID().replace(/-/g, "").toUpperCase().slice(0, 9)}0`;
  const row = await db
    .insert(instruments)
    .values({
      isin,
      ticker: null,
      name,
      kind: "fund",
      currency: EUR,
      priceSource: "manual",
      sourceKey: isin,
    })
    .returning({ id: instruments.id })
    .get();
  return row.id;
};

/** One user holding 10 units of `instrumentId` priced at 100 €: worth 1 000 €. */
const hold = async (userId: string, instrumentId: number): Promise<void> => {
  const account = await db
    .insert(accounts)
    .values({ userId, name: "Nordnet", broker: "nordnet", accountType: "aot", kind: "brokerage" })
    .returning({ id: accounts.id })
    .get();
  await db
    .insert(transactions)
    .values({
      accountId: account.id,
      instrumentId,
      type: "BUY",
      tradeDate: "2026-01-10",
      quantity: 10_000_000,
      unitPrice: null,
      amount: -1000_00,
      fee: 0,
      tax: 0,
      currency: EUR,
      fxRateEur: 100_000_000,
      contentHash: crypto.randomUUID(),
      externalId: null,
      importId: null,
    })
    .run();
  await db
    .insert(prices)
    .values({
      instrumentId,
      date: "2026-06-01",
      close: 100_00,
      currency: EUR,
      source: "manual",
      fetchedAt: new Date(),
    })
    .onConflictDoNothing()
    .run();
};

const ON = "2026-11-09";

describe("forecastFor", () => {
  test("uses only the caller's holdings and plan", async () => {
    const mine = await signUp();
    const theirs = await signUp();
    const a = await makeInstrument("Mine");
    const b = await makeInstrument("Theirs");
    const planned = await makeInstrument("Planned");
    await hold(mine, a);
    await hold(theirs, b);
    await plan.setPlanRow(db, mine, { instrumentId: planned, amountEur: "100" });
    await plan.setPlanRow(db, theirs, { instrumentId: b, amountEur: "999" });
    await rates.setRateOverride(db, mine, { instrumentId: a, ratePercent: "0" });
    await rates.setRateOverride(db, mine, { instrumentId: planned, ratePercent: "0" });

    const out = await service.forecastFor(db, mine, { months: 12, real: false, on: ON });
    expect(out.holdings.map((row) => [row.name, row.valueEur, row.monthlyEur, row.basis])).toEqual([
      ["Mine", 1000, 0, "user"],
      ["Planned", 0, 100, "user"],
    ]);
    expect(out.scenario.startDate).toBe("2026-11");
    expect(out.result.points[12]?.total.expected).toBe(2200);
    expect(out.result.points[12]?.contributedEur).toBe(1200);
  });

  test("selected instruments narrow the scenario", async () => {
    const userId = await signUp();
    const a = await makeInstrument("A");
    const b = await makeInstrument("B");
    await hold(userId, a);
    await hold(userId, b);
    const out = await service.forecastFor(db, userId, { months: 1, instrumentIds: [b], on: ON });
    expect(out.holdings.map((row) => row.instrumentId)).toEqual([b]);
  });

  test("options are validated at the boundary", async () => {
    const userId = await signUp();
    await expect(service.forecastFor(db, userId, { months: 601 })).rejects.toThrow();
    await expect(service.forecastFor(db, userId, { months: 0 })).rejects.toThrow();
  });

  test("defaults: ten years in today's euros", async () => {
    const userId = await signUp();
    const out = await service.forecastFor(db, userId, { on: ON });
    expect(out.result.points).toHaveLength(121);
    expect(out.result.real).toBe(true);
  });
});

describe("ForecastScenarioInput", () => {
  const base = {
    startDate: "2026-11",
    months: 12,
    holdings: [{ id: "a", name: "A", valueEur: 100, rate: 0.05, volatility: 0.1 }],
  };

  test("a plain scenario parses with defaults and runs", async () => {
    const { ForecastScenarioInput } = await import("./forecast-inputs.ts");
    const { forecast } = await import("../core/forecast.ts");
    const parsed = ForecastScenarioInput.parse(base);
    expect(parsed).toMatchObject({
      contributions: [],
      events: [],
      shocks: [],
      real: true,
      inflation: 0.02,
    });
    expect(forecast(parsed).points).toHaveLength(13);
  });

  test.each([
    ["an unknown holding", { contributions: [{ holdingId: "b", monthlyEur: 10 }] }],
    ["a duplicate id", { holdings: [...base.holdings, ...base.holdings] }],
    ["too long a horizon", { months: 601 }],
    ["a bad month", { startDate: "2026-13" }],
    ["a shock below −100 %", { shocks: [{ month: 1, holdingId: null, change: -1.5 }] }],
    ["no holdings", { holdings: [] }],
  ])("refuses %s", async (_name, change) => {
    const { ForecastScenarioInput } = await import("./forecast-inputs.ts");
    expect(ForecastScenarioInput.safeParse({ ...base, ...change }).success).toBe(false);
  });
});

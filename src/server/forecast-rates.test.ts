import { beforeAll, describe, expect, test } from "vitest";

import type { InstrumentKind } from "../core/types.ts";
import { EUR } from "../core/money.ts";
import { ForecastRateInput } from "./forecast-inputs.ts";
import { db } from "./db/index.ts";
import { prices } from "./db/schema.ts";
import { addInstrument } from "./instruments/store.ts";

let auth: ReturnType<(typeof import("./auth.ts"))["getAuth"]>;
let rates: typeof import("./forecast-rates.ts");

beforeAll(async () => {
  auth = (await import("./auth.ts")).getAuth();
  rates = await import("./forecast-rates.ts");
});

const signUp = async (): Promise<string> => {
  const response = await auth.handler(
    new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Test User",
        email: `rates-${crypto.randomUUID()}@example.com`,
        password: "correct horse battery staple",
      }),
    }),
  );
  if (response.status !== 200) throw new Error(`sign-up failed with status ${response.status}`);
  // SAFETY: a 200 from POST /sign-up/email carries `{ user: { id } }`.
  const body = (await response.json()) as { user: { id: string } };
  return body.user.id;
};

const instrument = async (kind: InstrumentKind = "etf"): Promise<number> =>
  (
    await addInstrument(db, {
      isin: `IE${crypto.randomUUID().replace(/-/g, "").toUpperCase().slice(0, 9)}0`,
      ticker: null,
      name: "Index",
      kind,
      currency: EUR,
      priceSource: "manual",
    })
  ).id;

/** One close on the 28th of each month from January 2014, `closeAt(k)` for month k. */
const seedMonthly = async (
  instrumentId: number,
  count: number,
  closeAt: (k: number) => number,
): Promise<void> => {
  const rows = Array.from({ length: count }, (_, k) => ({
    instrumentId,
    date: `${2014 + Math.floor(k / 12)}-${String((k % 12) + 1).padStart(2, "0")}-28`,
    close: Math.round(closeAt(k)),
    currency: EUR,
    source: "manual",
    fetchedAt: new Date(),
  }));
  // D1 binds at most 100 variables per statement: 6 columns, so 16 rows at a time.
  for (let at = 0; at < rows.length; at += 16) {
    await db
      .insert(prices)
      .values(rows.slice(at, at + 16))
      .run();
  }
};

const ON = "2030-01-01";

describe("forecast rates", () => {
  test("10+ years of history uses the instrument's own growth", async () => {
    const userId = await signUp();
    const id = await instrument();
    await seedMonthly(id, 12 * 12 + 1, (k) => 1_000_000 * 1.08 ** (k / 12));
    const rate = (await rates.ratesFor(db, userId, [{ instrumentId: id, kind: "etf" }], ON)).get(
      id,
    );
    expect(rate?.basis).toBe("history");
    expect(rate?.rate).toBeCloseTo(0.08, 3);
    expect(rate?.volatility).toBeCloseTo(0, 3);
    // The window's own span: the CAGR, weight and label share it.
    expect(rate?.yearsOfHistory).toBeCloseTo(10, 1);
  });

  test("2 years blends 20 % own with 80 % default", async () => {
    const userId = await signUp();
    const id = await instrument();
    // Alternating ±ln 1.1: zero mean, sample sd = ln 1.1 · √(24/23).
    await seedMonthly(id, 25, (k) => 1_000_000 * 1.1 ** (k % 2));
    const rate = (await rates.ratesFor(db, userId, [{ instrumentId: id, kind: "etf" }], ON)).get(
      id,
    );
    const years = 730 / 365.25;
    const weight = years / 10;
    const ownVol = Math.log(1.1) * Math.sqrt(24 / 23) * Math.sqrt(12);
    expect(rate?.basis).toBe("blend");
    expect(rate?.rate).toBeCloseTo((1 - weight) * 0.06, 6);
    expect(rate?.volatility).toBeCloseTo(weight * ownVol + (1 - weight) * 0.18, 6);
  });

  test("a wild CAGR is clamped to ±50 % before blending", async () => {
    const userId = await signUp();
    const id = await instrument();
    await seedMonthly(id, 25, (k) => 1_000 * 4 ** (k / 12));
    const rate = (await rates.ratesFor(db, userId, [{ instrumentId: id, kind: "stock" }], ON)).get(
      id,
    );
    const weight = 730 / 365.25 / 10;
    expect(rate?.rate).toBeCloseTo(weight * 0.5 + (1 - weight) * 0.06, 6);
  });

  /** Closes on given dates, for windows the monthly seeder cannot shape. */
  const seedAt = async (instrumentId: number, rows: readonly [string, number][]) => {
    await db
      .insert(prices)
      .values(
        rows.map(([date, close]) => ({
          instrumentId,
          date,
          close,
          currency: EUR,
          source: "manual",
          fetchedAt: new Date(),
        })),
      )
      .run();
  };

  test("the window starts at the last close on or before ten years back", async () => {
    const userId = await signUp();
    const id = await instrument();
    await seedAt(id, [
      ["2012-01-02", 100],
      ["2024-01-02", 100],
    ]);
    const rate = (await rates.ratesFor(db, userId, [{ instrumentId: id, kind: "etf" }], ON)).get(
      id,
    );
    expect(rate?.basis).toBe("history");
    expect(rate?.rate).toBe(0);
    expect(rate?.yearsOfHistory).toBeCloseTo(12, 1);
  });

  test("a late close inside the window does not shorten the span", async () => {
    const userId = await signUp();
    const id = await instrument();
    await seedAt(id, [
      ["2012-01-02", 100],
      ["2023-11-01", 100],
      ["2024-01-02", 110],
    ]);
    const rate = (await rates.ratesFor(db, userId, [{ instrumentId: id, kind: "etf" }], ON)).get(
      id,
    );
    const years = 4383 / 365.25;
    expect(rate?.basis).toBe("history");
    expect(rate?.rate).toBeCloseTo(1.1 ** (1 / years) - 1, 6);
    expect(rate?.yearsOfHistory).toBeCloseTo(years, 6);
  });

  test("measured volatility is clamped to 2 so the scenario re-validates", async () => {
    const userId = await signUp();
    const id = await instrument();
    await seedMonthly(id, 125, (k) => (k % 2 === 0 ? 1_000_000 : 1_000));
    const rate = (await rates.ratesFor(db, userId, [{ instrumentId: id, kind: "stock" }], ON)).get(
      id,
    );
    expect(rate?.volatility).toBe(2);
  });

  test("under a year of history is the default", async () => {
    const userId = await signUp();
    const id = await instrument("fund");
    await seedMonthly(id, 6, (k) => 1_000_000 + k * 50_000);
    const rate = (await rates.ratesFor(db, userId, [{ instrumentId: id, kind: "fund" }], ON)).get(
      id,
    );
    expect(rate).toMatchObject({ rate: 0.06, volatility: 0.18, basis: "default" });
  });

  test("cash grows at 0 by default", async () => {
    const userId = await signUp();
    const id = await instrument("cash");
    const rate = (await rates.ratesFor(db, userId, [{ instrumentId: id, kind: "cash" }], ON)).get(
      id,
    );
    expect(rate).toMatchObject({ rate: 0, volatility: 0, basis: "default", yearsOfHistory: 0 });
  });

  test("an override wins, keeps the measured volatility, and is removable", async () => {
    const userId = await signUp();
    const id = await instrument();
    await rates.setRateOverride(db, userId, { instrumentId: id, ratePercent: "4,5" });
    const held = [{ instrumentId: id, kind: "etf" as const }];
    expect((await rates.ratesFor(db, userId, held, ON)).get(id)).toMatchObject({
      rate: 0.045,
      volatility: 0.18,
      basis: "user",
    });
    await rates.setRateOverride(db, userId, { instrumentId: id, ratePercent: "-2" });
    expect((await rates.ratesFor(db, userId, held, ON)).get(id)?.rate).toBe(-0.02);
    await rates.removeRateOverride(db, userId, id);
    expect((await rates.ratesFor(db, userId, held, ON)).get(id)?.basis).toBe("default");
  });

  test("another user's override is not used", async () => {
    const mine = await signUp();
    const theirs = await signUp();
    const id = await instrument();
    await rates.setRateOverride(db, theirs, { instrumentId: id, ratePercent: "20" });
    const rate = (await rates.ratesFor(db, mine, [{ instrumentId: id, kind: "etf" }], ON)).get(id);
    expect(rate?.basis).toBe("default");
  });

  test("an unknown instrument is refused", async () => {
    const userId = await signUp();
    await expect(
      rates.setRateOverride(db, userId, { instrumentId: 999_999_999, ratePercent: "5" }),
    ).rejects.toThrow("Instrument not found");
  });
});

describe("ForecastRateInput", () => {
  const parse = (ratePercent: string) =>
    ForecastRateInput.safeParse({ instrumentId: 1, ratePercent });
  test.each(["", "abc", "50.01", "-50.01", "1.234", "1e2"])("refuses %j", (value) => {
    expect(parse(value).success).toBe(false);
  });
  test.each(["0", "6", "-3,5", "50", "-50.00"])("accepts %j", (value) => {
    expect(parse(value).success).toBe(true);
  });
});

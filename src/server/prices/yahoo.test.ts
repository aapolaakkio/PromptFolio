import { expect, test } from "bun:test";

import { parseCurrency } from "../../core/money";
import { YAHOO } from "./yahoo";

const fixture = (name: string) => Bun.file(`${import.meta.dir}/fixtures/${name}`).text();

/** Recorded 2026-08-27 from `query1.finance.yahoo.com/v8/finance/chart/NOKIA.HE?range=5d&interval=1d`. */
const stubFetch = async (): Promise<Response> =>
  new Response(await fixture("yahoo-nokia.json"), {
    headers: { "content-type": "application/json" },
  });

test("parses the real fixture into dated closes in minor units, currency observed from the response", async () => {
  const prices = await YAHOO.fetch({
    sourceKey: "NOKIA.HE",
    from: "2025-01-01",
    to: "2025-12-31",
    fetchImpl: stubFetch,
  });
  expect(prices.length).toBeGreaterThan(0);
  for (const point of prices) {
    expect(point.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isInteger(point.closeMinor)).toBe(true);
    expect(point.closeMinor).toBeGreaterThan(0);
    expect(point.currency).toBe(parseCurrency("EUR"));
  }
});

test("drops days whose close is null instead of emitting zero", async () => {
  const withGap = async (): Promise<Response> =>
    Response.json({
      chart: {
        result: [
          {
            meta: { currency: "EUR" },
            timestamp: [1735689600, 1735776000],
            indicators: { quote: [{ close: [4.15, null] }] },
          },
        ],
        error: null,
      },
    });
  const prices = await YAHOO.fetch({
    sourceKey: "X",
    from: "2025-01-01",
    to: "2025-01-02",
    fetchImpl: withGap,
  });
  expect(prices).toHaveLength(1);
  expect(prices[0]!.closeMinor).toBe(415);
});

test("carries a non-EUR/USD currency through rather than rejecting it", async () => {
  const sek = async (): Promise<Response> =>
    Response.json({
      chart: {
        result: [
          {
            meta: { currency: "SEK" },
            timestamp: [1735689600],
            indicators: { quote: [{ close: [123.45] }] },
          },
        ],
        error: null,
      },
    });
  const prices = await YAHOO.fetch({
    sourceKey: "X.ST",
    from: "2025-01-01",
    to: "2025-01-02",
    fetchImpl: sek,
  });
  expect(prices).toHaveLength(1);
  expect(prices[0]!.currency).toBe(parseCurrency("SEK"));
});

test("rejects an unparseable currency code loudly instead of guessing", async () => {
  const badCurrency = async (): Promise<Response> =>
    Response.json({
      chart: {
        result: [
          {
            meta: { currency: "not-a-currency" },
            timestamp: [1735689600],
            indicators: { quote: [{ close: [1] }] },
          },
        ],
        error: null,
      },
    });
  await expect(
    YAHOO.fetch({ sourceKey: "X", from: "2025-01-01", to: "2025-01-02", fetchImpl: badCurrency }),
  ).rejects.toThrow();
});

// Reproduced live during review: `close: [0]` returned `closeMinor: 0`,
// `close: [-5]` returned `closeMinor: -500`, both as if they were valid
// closes, before `requirePositiveMinor` existed. A zero/negative close is
// never real for a listed security and must fail loudly instead of
// flowing into the portfolio total.

test("rejects a zero close instead of returning it as a valid price", async () => {
  const zero = async (): Promise<Response> =>
    Response.json({
      chart: {
        result: [
          {
            meta: { currency: "EUR" },
            timestamp: [1735689600],
            indicators: { quote: [{ close: [0] }] },
          },
        ],
        error: null,
      },
    });
  await expect(
    YAHOO.fetch({ sourceKey: "X", from: "2025-01-01", to: "2025-01-02", fetchImpl: zero }),
  ).rejects.toThrow(/epäkelpo hinta/);
});

test("rejects a negative close instead of returning it as a valid price", async () => {
  const negative = async (): Promise<Response> =>
    Response.json({
      chart: {
        result: [
          {
            meta: { currency: "EUR" },
            timestamp: [1735689600],
            indicators: { quote: [{ close: [-5] }] },
          },
        ],
        error: null,
      },
    });
  await expect(
    YAHOO.fetch({ sourceKey: "X", from: "2025-01-01", to: "2025-01-02", fetchImpl: negative }),
  ).rejects.toThrow(/epäkelpo hinta/);
});

test("rejects a payload that does not match the expected schema", async () => {
  const garbage = async (): Promise<Response> => Response.json({ unexpected: true });
  await expect(
    YAHOO.fetch({ sourceKey: "X", from: "2025-01-01", to: "2025-01-02", fetchImpl: garbage }),
  ).rejects.toThrow();
});

test("surfaces a non-200 response as an error", async () => {
  const failing = async (): Promise<Response> => new Response("rate limited", { status: 429 });
  await expect(
    YAHOO.fetch({ sourceKey: "X", from: "2025-01-01", to: "2025-01-02", fetchImpl: failing }),
  ).rejects.toThrow(/429/);
});

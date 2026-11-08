import { describe, expect, it } from "vitest";

import { parseCurrency } from "../../core/money.ts";
import { fetchLatestQuotes } from "./yahoo-batch.ts";
import { YahooPausedError } from "./yahoo-gate.ts";
import { urlOf, type FetchImpl } from "./types.ts";

const chartBody = (currency: string, closes: readonly number[]): string =>
  JSON.stringify({
    chart: {
      result: [
        {
          meta: { currency },
          timestamp: closes.map((_, i) => 1_700_000_000 + i * 86_400),
          indicators: { quote: [{ close: closes }] },
        },
      ],
    },
  });

const stub = (routes: Record<string, Response>) => {
  const urls: string[] = [];
  const fetchImpl: FetchImpl = async (input) => {
    const url = urlOf(input);
    urls.push(url);
    const hit = Object.entries(routes).find(([needle]) => url.includes(needle));
    if (hit === undefined) return new Response("", { status: 404 });
    return hit[1].clone();
  };
  return { urls, fetchImpl };
};

describe("fetchLatestQuotes", () => {
  it("returns every symbol's latest close and currency", async () => {
    const { urls, fetchImpl } = stub({
      "chart/NOKIA.HE": new Response(chartBody("EUR", [4.1, 4.25])),
      "chart/KCR.HE": new Response(chartBody("EUR", [1.5])),
    });
    const quotes = await fetchLatestQuotes(["NOKIA.HE", "KCR.HE"], fetchImpl, 0);
    expect(quotes.get("NOKIA.HE")).toMatchObject({
      closeMinor: 425,
      currency: parseCurrency("EUR"),
    });
    expect(quotes.get("KCR.HE")).toMatchObject({ closeMinor: 150 });
    expect(urls).toHaveLength(2);
  });

  it("an unknown symbol is absent, not an error", async () => {
    const { fetchImpl } = stub({ "chart/NOKIA.HE": new Response(chartBody("EUR", [4])) });
    const quotes = await fetchLatestQuotes(["NOPE.HE", "NOKIA.HE"], fetchImpl, 0);
    expect([...quotes.keys()]).toEqual(["NOKIA.HE"]);
  });

  it("waits between symbols, not before the first or after the last", async () => {
    const { fetchImpl } = stub({ chart: new Response(chartBody("EUR", [1])) });
    const started = Date.now();
    await fetchLatestQuotes(["A", "B"], fetchImpl, 120);
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(110);
    expect(took).toBeLessThan(240);
  });

  it("a pause from the gate propagates", async () => {
    const fetchImpl: FetchImpl = async () => {
      throw new YahooPausedError(1);
    };
    await expect(fetchLatestQuotes(["A"], fetchImpl, 0)).rejects.toBeInstanceOf(YahooPausedError);
  });
});

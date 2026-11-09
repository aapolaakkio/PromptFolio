import { readText } from "../files.ts";
import { urlOf } from "../prices/types.ts";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { parseCurrency } from "../../core/money.ts";
import type { ChatClient } from "../chat/runner.ts";
import type { PageRecipe } from "../prices/page-recipe.ts";
import { gatedFetch } from "../prices/yahoo-gate.ts";
import { db } from "../db/index.ts";
import { yahooGate } from "../db/schema.ts";
import { lookupInstrument as lookupWithSpacing } from "./lookup.ts";
import type { PageFinder } from "./find-page.ts";
import { figiLookup } from "./openfigi.ts";
import { candidateSymbols } from "./venues.ts";

const EUR = parseCurrency("EUR");

// No pause between quote requests: the tests would otherwise sit out 2 s each.
const lookupInstrument = (
  isin: Parameters<typeof lookupWithSpacing>[0],
  name: string,
  currency: Parameters<typeof lookupWithSpacing>[2],
  fetchImpl: typeof fetch,
) => lookupWithSpacing(isin, name, currency, fetchImpl, 0);

const USD = parseCurrency("USD");

const fixture = (name: string): Promise<string> =>
  readText(new URL(`./fixtures/${name}`, import.meta.url));

/**
 * A fetch stub keyed by substring of the requested URL, longest key first so
 * a per-symbol chart route wins over a generic one. Anything unmatched throws,
 * so a test that reaches an unexpected endpoint fails loudly instead of
 * silently resolving; no test here touches the network (test-network-guard.ts
 * enforces that globally).
 */
const stubFetch = (routes: Record<string, { body: string; status?: number }>): typeof fetch => {
  const ordered = Object.entries(routes).sort(([a], [b]) => b.length - a.length);
  // SAFETY: every call site below passes only a URL and reads only the
  // Response, so this single-argument function covers the whole of fetch as
  // this codebase uses it; the assertion exists because fetch's own type
  // cannot be satisfied structurally without restating its overloads.
  return (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    for (const [needle, response] of ordered) {
      if (url.includes(needle)) {
        return new Response(response.body, { status: response.status ?? 200 });
      }
    }
    throw new Error(`odottamaton pyyntö: ${url}`);
  }) as typeof fetch;
};

const chart = (currency: string) => ({
  body: JSON.stringify({
    chart: {
      result: [
        {
          meta: { currency },
          timestamp: [1_700_000_000],
          indicators: { quote: [{ close: [1.5] }] },
        },
      ],
    },
  }),
});

const figiBody = (
  name: string,
  securityType: string,
  venues: Array<{ ticker: string; exchCode: string }> = [],
): string =>
  JSON.stringify([
    { data: [{ name, securityType, ...venues[0] }, ...venues.slice(1).map((v) => ({ ...v }))] },
  ]);

describe("figiLookup", () => {
  test("resolves a listed share to its kind, name and venues", async () => {
    const result = await figiLookup(
      "FI0009000681",
      stubFetch({ openfigi: { body: await fixture("figi-nokia.json") } }),
    );
    expect(result?.kind).toBe("stock");
    expect(result?.name).toBe("NOKIA OYJ");
    expect(result?.venues.some((v) => v.exchCode === "FH" && v.ticker === "NOKIA")).toBe(true);
  });

  test("resolves a Finnish non-listed fund", async () => {
    const result = await figiLookup(
      "FI4000261128",
      stubFetch({ openfigi: { body: await fixture("figi-op-maailma.json") } }),
    );
    expect(result?.kind).toBe("fund");
    expect(result?.name).toBe("OP-WORLD INDEX FUND-A EUR");
  });

  test("returns null for a well-formed ISIN the registry does not know", async () => {
    expect(
      await figiLookup(
        "FI0000000003",
        stubFetch({ openfigi: { body: await fixture("figi-unknown.json") } }),
      ),
    ).toBeNull();
  });

  test("returns null for a malformed ISIN rather than throwing", async () => {
    expect(
      await figiLookup(
        "XX0000000000",
        stubFetch({ openfigi: { body: await fixture("figi-invalid.json") } }),
      ),
    ).toBeNull();
  });

  test("returns null when the registry is unavailable", async () => {
    expect(
      await figiLookup("FI0009000681", stubFetch({ openfigi: { body: "", status: 503 } })),
    ).toBeNull();
  });
});

describe("candidateSymbols", () => {
  test("puts Yahoo's own hits first, then one symbol per known venue", () => {
    expect(
      candidateSymbols(
        ["IWDA.L"],
        [
          { ticker: "IWDA", exchCode: "NA" },
          { ticker: "EUNL", exchCode: "GR" },
        ],
      ),
    ).toEqual(["IWDA.L", "IWDA.AS", "EUNL.DE"]);
  });

  test("skips venues with no Yahoo suffix and never repeats a symbol", () => {
    expect(
      candidateSymbols(
        ["IWDA.AS"],
        [
          { ticker: "IWDA", exchCode: "NA" },
          { ticker: "IWDA", exchCode: "XJ" },
        ],
      ),
    ).toEqual(["IWDA.AS"]);
  });

  test("caps the probe list so a 100-venue security stays one quick registration", () => {
    const venues = Array.from({ length: 40 }, (_, i) => ({ ticker: `T${i}`, exchCode: "GR" }));
    expect(candidateSymbols([], venues, 3)).toHaveLength(3);
  });
});

describe("lookupInstrument", () => {
  test("a listed share resolves to its home listing", async () => {
    const result = await lookupInstrument(
      "FI0009000681",
      "NOKIA",
      EUR,
      stubFetch({
        openfigi: { body: await fixture("figi-nokia.json") },
        "finance/search": { body: await fixture("yahoo-search-nokia.json") },
        "chart/NOKIA.HE": chart("EUR"),
      }),
    );
    expect(result).toEqual({
      kind: "stock",
      name: "NOKIA OYJ",
      priceSource: "yahoo",
      sourceKey: "NOKIA.HE",
      isin: "FI0009000681",
      listingCurrency: EUR,
      outcome: "found",
      formReason: null,
      pageRecipe: null,
    });
  });

  test("an ETF padded with an ISIN placeholder quote still resolves", async () => {
    const result = await lookupInstrument(
      "IE0002Y8CX98",
      "WISDOMTREE EUROPE DEFENCE",
      EUR,
      stubFetch({
        openfigi: { body: figiBody("WT EUROPE DEFENCE UCITS ETF", "ETP") },
        "finance/search": { body: await fixture("yahoo-search-eudf.json") },
        "chart/EUDF.DE": chart("EUR"),
      }),
    );
    expect(result.sourceKey).toBe("EUDF.DE");
    expect(result.kind).toBe("etf");
  });

  test("picks the listing quoted in the holding's currency, not the first one found", async () => {
    const routes = {
      openfigi: {
        body: figiBody("ISHARES CORE MSCI WORLD", "ETP", [
          { ticker: "IWDA", exchCode: "NA" },
          { ticker: "EUNL", exchCode: "GR" },
        ]),
      },
      "finance/search": { body: await fixture("yahoo-search-iwda.json") },
      "chart/IWDA.L": chart("USD"),
      "chart/IWDA.AS": chart("EUR"),
    };

    const eurHolding = await lookupInstrument("IE00B4L5Y983", "IWDA", EUR, stubFetch(routes));
    expect(eurHolding.sourceKey).toBe("IWDA.AS");
    expect(eurHolding.listingCurrency).toBe(EUR);

    const usdHolding = await lookupInstrument("IE00B4L5Y983", "IWDA", USD, stubFetch(routes));
    expect(usdHolding.sourceKey).toBe("IWDA.L");
    expect(usdHolding.listingCurrency).toBe(USD);
  });

  test("offers the only listing there is, and reports its currency, when none matches", async () => {
    const result = await lookupInstrument(
      "IE00B4L5Y983",
      "IWDA",
      parseCurrency("SEK"),
      stubFetch({
        openfigi: { body: figiBody("ISHARES CORE MSCI WORLD", "ETP") },
        "finance/search": { body: await fixture("yahoo-search-iwda.json") },
        "chart/IWDA.L": chart("USD"),
      }),
    );
    expect(result.sourceKey).toBe("IWDA.L");
    expect(result.listingCurrency).toBe(USD);
    expect(result.outcome).toBe("form");
    expect(result.formReason).toBe("currency");
  });

  test("falls back to Yahoo's own quoteType when OpenFIGI answers nothing", async () => {
    const result = await lookupInstrument(
      "IE0002Y8CX98",
      "WISDOMTREE EUROPE DEFENCE",
      EUR,
      stubFetch({
        openfigi: { body: "", status: 429 },
        "finance/search": { body: await fixture("yahoo-search-eudf.json") },
        "chart/EUDF.DE": chart("EUR"),
      }),
    );
    expect(result.kind).toBe("etf");
    expect(result.sourceKey).toBe("EUDF.DE");
    expect(result.name).toBeNull();
  });

  test("a fund Yahoo can price is priced from Yahoo, not from a bank's own page", async () => {
    const result = await lookupInstrument(
      "FI4000261128",
      "OP-MAAILMA INDEKSI A",
      EUR,
      stubFetch({
        openfigi: { body: await fixture("figi-op-maailma.json") },
        "finance/search": { body: JSON.stringify({ quotes: [{ symbol: "0P0001BP5K.F" }] }) },
        "chart/0P0001BP5K.F": chart("EUR"),
      }),
    );
    expect(result.priceSource).toBe("yahoo");
    expect(result.sourceKey).toBe("0P0001BP5K.F");
    expect(result.kind).toBe("fund");
  });

  test("resolves nothing rather than guessing when every source comes up empty", async () => {
    const result = await lookupInstrument(
      "FI0000000003",
      "Tuntematon",
      EUR,
      stubFetch({
        openfigi: { body: await fixture("figi-unknown.json") },
        "finance/search": { body: await fixture("yahoo-search-none.json") },
        "op.fi": { body: "", status: 404 },
      }),
    );
    expect(result).toEqual({
      kind: null,
      name: null,
      priceSource: null,
      sourceKey: null,
      isin: "FI0000000003",
      listingCurrency: null,
      outcome: "form",
      formReason: "nothing",
      pageRecipe: null,
    });
  });

  test("a share Yahoo cannot price is reported as its kind, with no source guessed", async () => {
    const result = await lookupInstrument(
      "FI0009000681",
      "NOKIA",
      EUR,
      stubFetch({
        openfigi: { body: figiBody("NOKIA OYJ", "Common Stock") },
        "finance/search": { body: await fixture("yahoo-search-none.json") },
      }),
    );
    expect(result.kind).toBe("stock");
    expect(result.priceSource).toBeNull();
    expect(result.sourceKey).toBeNull();
  });
});

describe("lookupInstrument by name, for an import that carries no ISIN", () => {
  const nameSearch = (quotes: Array<Record<string, string>>) => ({
    body: JSON.stringify({ quotes }),
  });

  test("resolves a share from its name alone, leaving the ISIN to be typed", async () => {
    const result = await lookupInstrument(
      null,
      "NOKIA OYJ",
      EUR,
      stubFetch({
        "op.fi": { body: "", status: 404 },
        "finance/search": nameSearch([
          { symbol: "NOKIA.HE", quoteType: "EQUITY", longname: "Nokia Oyj" },
        ]),
        "chart/NOKIA.HE": chart("EUR"),
      }),
    );
    expect(result.priceSource).toBe("yahoo");
    expect(result.sourceKey).toBe("NOKIA.HE");
    expect(result.kind).toBe("stock");
    // No free source checked maps a name or ticker back to an ISIN, so this
    // stays null rather than being invented.
    expect(result.isin).toBeNull();
    expect(result.outcome).toBe("form");
    expect(result.formReason).toBe("name");
  });

  test("refuses a match whose name is a different company", async () => {
    const result = await lookupInstrument(
      null,
      "NOKIA OYJ",
      EUR,
      stubFetch({
        "op.fi": { body: "", status: 404 },
        "finance/search": nameSearch([
          { symbol: "TYRES.HE", quoteType: "EQUITY", longname: "Nokian Renkaat Oyj" },
        ]),
      }),
    );
    expect(result.sourceKey).toBeNull();
    expect(result.priceSource).toBeNull();
  });

  test("ignores the company-form suffix a broker prints", async () => {
    const result = await lookupInstrument(
      null,
      "ESIMERKKI OYJ",
      EUR,
      stubFetch({
        "op.fi": { body: "", status: 404 },
        "finance/search": nameSearch([
          { symbol: "K34.F", quoteType: "EQUITY", longname: "Esimerkki Plc" },
        ]),
        "chart/K34.F": chart("EUR"),
      }),
    );
    expect(result.sourceKey).toBe("K34.F");
  });

  test("picks the listing quoted in the holding's currency, not merely the first named match", async () => {
    const routes = {
      "op.fi": { body: "", status: 404 },
      "finance/search": nameSearch([
        { symbol: "NOK", quoteType: "EQUITY", longname: "Nokia Oyj" },
        { symbol: "NOKIA.HE", quoteType: "EQUITY", longname: "Nokia Oyj" },
      ]),
      "chart/NOK": chart("USD"),
      "chart/NOKIA.HE": chart("EUR"),
    };
    expect((await lookupInstrument(null, "NOKIA OYJ", EUR, stubFetch(routes))).sourceKey).toBe(
      "NOKIA.HE",
    );
    expect((await lookupInstrument(null, "NOKIA OYJ", USD, stubFetch(routes))).sourceKey).toBe(
      "NOK",
    );
  });
});

describe("name search, company-form suffix", () => {
  test("tries the bare name first, which is what surfaces the home listing", async () => {
    const asked: string[] = [];
    // SAFETY: as in stubFetch above -- only a URL is ever passed and only the
    // Response is read, which `typeof fetch` cannot express structurally.
    const stub = (async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url.includes("op.fi")) return new Response("", { status: 404 });
      if (url.includes("finance/search")) {
        const term = new URL(url).searchParams.get("q") ?? "";
        asked.push(term);
        // Yahoo's own behaviour, recorded 2026-08-28: the bare name returns the
        // Helsinki listing first; with "OYJ" appended it is absent entirely.
        const quotes =
          term === "ESIMERKKI"
            ? [{ symbol: "KCR.HE", quoteType: "EQUITY", longname: "Esimerkki Plc" }]
            : [{ symbol: "K34.F", quoteType: "EQUITY", longname: "Esimerkki Plc" }];
        return new Response(JSON.stringify({ quotes }));
      }
      return new Response(chart("EUR").body);
    }) as typeof fetch;
    const byName = await lookupInstrument(null, "ESIMERKKI OYJ", EUR, stub);
    expect(asked[0]).toBe("ESIMERKKI");
    expect(byName.sourceKey).toBe("KCR.HE");
  });
});

describe("lookupInstrument, paused Yahoo and request cost", () => {
  beforeEach(async () => {
    await db.delete(yahooGate).run();
  });

  test("a 429 during the lookup is pending, not nothing-found", async () => {
    const base = stubFetch({
      openfigi: { body: await fixture("figi-nokia.json") },
      "finance/search": { body: "", status: 429 },
    });
    const result = await lookupInstrument("FI0009000681", "NOKIA", EUR, gatedFetch(db, base));
    expect(result.outcome).toBe("pending");
    expect(result.formReason).toBeNull();
    expect(result.sourceKey).toBeNull();
  });

  const countQuotes = (routes: Record<string, { body: string; status?: number }>) => {
    const state = { quoteRequests: 0 };
    const inner = stubFetch(routes);
    // SAFETY: only a URL is passed and only the Response is read, as in stubFetch.
    const stub = (async (input: RequestInfo | URL) => {
      if (urlOf(input).includes("v8/finance/chart")) state.quoteRequests += 1;
      return await inner(input);
    }) as typeof fetch;
    return { state, stub };
  };
  const manyCandidates = (second: string) => ({
    openfigi: { body: figiBody("NOKIA OYJ", "Common Stock") },
    "finance/search": {
      body: JSON.stringify({
        quotes: [{ symbol: "A.HE" }, { symbol: "B.HE" }, { symbol: "C.HE" }],
      }),
    },
    "chart/A.HE": chart("EUR"),
    "chart/B.HE": chart(second),
    "chart/C.HE": chart("EUR"),
  });

  test("candidate listings cost one request when the first matches", async () => {
    const { state, stub } = countQuotes(manyCandidates("EUR"));
    const result = await lookupInstrument("FI0009000681", "NOKIA", EUR, stub);
    expect(result.sourceKey).toBe("A.HE");
    expect(state.quoteRequests).toBe(1);
  });

  test("probing stops at the second candidate when that is the first match", async () => {
    const { state, stub } = countQuotes({ ...manyCandidates("EUR"), "chart/A.HE": chart("USD") });
    const result = await lookupInstrument("FI0009000681", "NOKIA", EUR, stub);
    expect(result.sourceKey).toBe("B.HE");
    expect(state.quoteRequests).toBe(2);
  });
});

describe("lookupInstrument, a page found by web search", () => {
  const FUND_ISIN = "SE0005993102";
  const FUND_NAME = "Nordnet Suomi Indeksi";
  const PAGE_URL = "https://www.nordnet.fi/rahastot/suomi-indeksi";
  const GOOD: PageRecipe = {
    kind: "page",
    pattern:
      String.raw`\\"currency\\":\\"(?<currency>[A-Z]{3})\\"\}\},\\"navInfo\\":\{[^}]*?\\"latestNav\\":` +
      String.raw`\{\\"date\\":\\"(?<date>\d{4}-\d{2}-\d{2})\\",\\"value\\":(?<price>[\d.]+)\}`,
    dateFormat: "yyyy-mm-dd",
    money: { decimal: ".", thousands: "", negative: "leading", twoColumn: false },
    currency: null,
  };
  const BAD: PageRecipe = { ...GOOD, pattern: String.raw`(?<date>nope)(?<price>nope)` };

  const page = () =>
    readText(new URL("../prices/fixtures/nordnet-fund-suomi.html", import.meta.url));

  const recipeClient = (recipe: PageRecipe | Error): ChatClient & { calls: number } => {
    const state = { calls: 0 };
    return {
      get calls() {
        return state.calls;
      },
      run: async () => {
        state.calls += 1;
        if (recipe instanceof Error) throw recipe;
        return { text: JSON.stringify(recipe), toolCalls: [] };
      },
    };
  };

  const finder = (answer: { url: string; isin: string | null } | null | Error) => {
    const asked: Array<Parameters<PageFinder>[0]> = [];
    const find: PageFinder = async (q) => {
      asked.push(q);
      if (answer instanceof Error) throw answer;
      return answer;
    };
    return { asked, find };
  };

  /** Every URL the lookup asked for, so a request that should not happen is seen. */
  const recording = (routes: Record<string, { body: string; status?: number }>) => {
    const urls: string[] = [];
    const inner = stubFetch(routes);
    // SAFETY: only a URL is passed and only the Response is read, as in stubFetch.
    const stub = (async (input: RequestInfo | URL) => {
      urls.push(urlOf(input));
      return await inner(input);
    }) as typeof fetch;
    return { urls, stub };
  };

  const misses = async () => ({
    openfigi: { body: await fixture("figi-unknown.json") },
    "finance/search": { body: await fixture("yahoo-search-none.json") },
    "op.fi": { body: "", status: 404 },
    [PAGE_URL]: { body: await page() },
  });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-27T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("a fund OpenFIGI and Yahoo miss is found by web search and verified", async () => {
    const { asked, find } = finder({ url: PAGE_URL, isin: FUND_ISIN });
    const client = recipeClient(GOOD);
    const result = await lookupWithSpacing(
      FUND_ISIN,
      FUND_NAME,
      EUR,
      stubFetch(await misses()),
      0,
      {
        find,
        client,
        referenceMinor: 36_000,
      },
    );

    expect(result).toMatchObject({
      outcome: "found",
      formReason: null,
      priceSource: "page",
      sourceKey: PAGE_URL,
      isin: FUND_ISIN,
      listingCurrency: EUR,
      pageRecipe: GOOD,
    });
    expect(asked).toEqual([{ isin: FUND_ISIN, name: FUND_NAME, currency: EUR }]);
  });

  test("a found page whose recipe fails goes to the form", async () => {
    const { find } = finder({ url: PAGE_URL, isin: FUND_ISIN });
    const result = await lookupWithSpacing(
      FUND_ISIN,
      FUND_NAME,
      EUR,
      stubFetch(await misses()),
      0,
      {
        find,
        client: recipeClient(BAD),
        referenceMinor: null,
      },
    );

    expect(result).toMatchObject({
      outcome: "form",
      formReason: "nothing",
      priceSource: null,
      sourceKey: null,
      pageRecipe: null,
    });
  });

  test("a hostile page priced far from the reference goes to the form", async () => {
    const { find } = finder({ url: PAGE_URL, isin: FUND_ISIN });
    const result = await lookupWithSpacing(
      FUND_ISIN,
      FUND_NAME,
      EUR,
      stubFetch(await misses()),
      0,
      {
        find,
        client: recipeClient(GOOD),
        referenceMinor: 1_000,
      },
    );

    expect(result.outcome).toBe("form");
    expect(result.priceSource).toBeNull();
  });

  test("an ISIN-less row gets its ISIN from the found page and is then priced by Yahoo", async () => {
    const { asked, find } = finder({ url: PAGE_URL, isin: FUND_ISIN });
    const client = recipeClient(GOOD);
    const result = await lookupWithSpacing(
      null,
      FUND_NAME,
      EUR,
      stubFetch({
        ...(await misses()),
        openfigi: { body: figiBody("NORDNET SUOMI INDEKSI", "Open-End Fund") },
        [`finance/search?q=${FUND_ISIN}`]: {
          body: JSON.stringify({ quotes: [{ symbol: "0P0000ABCD.F", quoteType: "MUTUALFUND" }] }),
        },
        "chart/0P0000ABCD.F": chart("EUR"),
      }),
      0,
      { find, client, referenceMinor: null },
    );

    expect(result).toMatchObject({
      outcome: "found",
      priceSource: "yahoo",
      sourceKey: "0P0000ABCD.F",
      isin: FUND_ISIN,
      pageRecipe: null,
    });
    expect(asked).toEqual([{ isin: null, name: FUND_NAME, currency: EUR }]);
    expect(client.calls).toBe(0);
  });

  test("an ISIN found on the page but unpriced by Yahoo reuses the page: one search, one fetch", async () => {
    const { asked, find } = finder({ url: PAGE_URL, isin: FUND_ISIN });
    const { urls, stub } = recording({
      ...(await misses()),
      openfigi: { body: figiBody("NORDNET SUOMI INDEKSI", "Open-End Fund") },
    });
    const result = await lookupWithSpacing(null, FUND_NAME, EUR, stub, 0, {
      find,
      client: recipeClient(GOOD),
      referenceMinor: null,
    });

    expect(result).toMatchObject({ outcome: "found", priceSource: "page", isin: FUND_ISIN });
    expect(asked).toHaveLength(1);
    expect(urls.filter((url) => url === PAGE_URL)).toHaveLength(1);
  });

  test("an ISIN-less row whose page shows no ISIN makes no recipe call and goes to the form", async () => {
    const { find } = finder({ url: PAGE_URL, isin: null });
    const client = recipeClient(GOOD);
    const result = await lookupWithSpacing(null, FUND_NAME, EUR, stubFetch(await misses()), 0, {
      find,
      client,
      referenceMinor: null,
    });

    expect(result).toMatchObject({ outcome: "form", priceSource: null, pageRecipe: null });
    expect(client.calls).toBe(0);
  });

  test("a page-claimed ISIN whose OpenFIGI name differs goes to the form", async () => {
    const { find } = finder({ url: PAGE_URL, isin: FUND_ISIN });
    const client = recipeClient(GOOD);
    const { urls, stub } = recording({
      ...(await misses()),
      openfigi: { body: figiBody("SOME OTHER FUND SICAV", "Open-End Fund") },
      [`finance/search?q=${FUND_ISIN}`]: {
        body: JSON.stringify({ quotes: [{ symbol: "0P0000ABCD.F", quoteType: "MUTUALFUND" }] }),
      },
      "chart/0P0000ABCD.F": chart("EUR"),
    });
    const result = await lookupWithSpacing(null, FUND_NAME, EUR, stub, 0, {
      find,
      client,
      referenceMinor: null,
    });

    expect(result).toMatchObject({
      outcome: "form",
      formReason: "name",
      priceSource: null,
      sourceKey: null,
      pageRecipe: null,
    });
    expect(urls.some((url) => url.includes("chart/"))).toBe(false);
    expect(client.calls).toBe(0);
  });

  test("a page-claimed ISIN OpenFIGI gives no name for goes to the form", async () => {
    const { find } = finder({ url: PAGE_URL, isin: FUND_ISIN });
    const result = await lookupWithSpacing(null, FUND_NAME, EUR, stubFetch(await misses()), 0, {
      find,
      client: recipeClient(GOOD),
      referenceMinor: null,
    });

    expect(result).toMatchObject({ outcome: "form", formReason: "name", priceSource: null });
  });

  test("a page-claimed ISIN whose OpenFIGI name agrees is priced by Yahoo", async () => {
    const { find } = finder({ url: PAGE_URL, isin: FUND_ISIN });
    const result = await lookupWithSpacing(
      null,
      "NORDNET SUOMI INDEKSI",
      EUR,
      stubFetch({
        ...(await misses()),
        openfigi: { body: figiBody("Nordnet Suomi Indeksi", "Open-End Fund") },
        [`finance/search?q=${FUND_ISIN}`]: {
          body: JSON.stringify({ quotes: [{ symbol: "0P0000ABCD.F", quoteType: "MUTUALFUND" }] }),
        },
        "chart/0P0000ABCD.F": chart("EUR"),
      }),
      0,
      { find, client: recipeClient(GOOD), referenceMinor: null },
    );

    expect(result).toMatchObject({
      outcome: "found",
      priceSource: "yahoo",
      sourceKey: "0P0000ABCD.F",
      isin: FUND_ISIN,
    });
  });

  test("an ISIN-less row with no currency never asks the finder", async () => {
    const { asked, find } = finder({ url: PAGE_URL, isin: FUND_ISIN });
    const result = await lookupWithSpacing(null, FUND_NAME, null, stubFetch(await misses()), 0, {
      find,
      client: recipeClient(GOOD),
      referenceMinor: null,
    });

    expect(asked).toEqual([]);
    expect(result).toMatchObject({ outcome: "form", priceSource: null });
  });

  test("an ISIN the page does not contain is not used", async () => {
    const { asked, find } = finder({ url: PAGE_URL, isin: "FI0000000003" });
    const { urls, stub } = recording(await misses());
    const result = await lookupWithSpacing(null, FUND_NAME, EUR, stub, 0, {
      find,
      client: recipeClient(BAD),
      referenceMinor: null,
    });

    expect(result.isin).toBeNull();
    expect(urls.some((url) => url.includes("openfigi") || url.includes("FI0000000003"))).toBe(
      false,
    );
    expect(asked).toHaveLength(1);
  });

  test("the finder or the model throwing is pending, never the form", async () => {
    const throwing = await lookupWithSpacing(
      FUND_ISIN,
      FUND_NAME,
      EUR,
      stubFetch(await misses()),
      0,
      {
        find: finder(new TypeError("fetch failed")).find,
        client: recipeClient(GOOD),
        referenceMinor: null,
      },
    );
    expect(throwing).toMatchObject({ outcome: "pending", isin: FUND_ISIN, formReason: null });

    const modelDown = await lookupWithSpacing(
      FUND_ISIN,
      FUND_NAME,
      EUR,
      stubFetch(await misses()),
      0,
      {
        find: finder({ url: PAGE_URL, isin: FUND_ISIN }).find,
        client: recipeClient(new TypeError("fetch failed")),
        referenceMinor: null,
      },
    );
    expect(modelDown).toMatchObject({ outcome: "pending", isin: FUND_ISIN });
  });

  test("a refusal from the finder or the model is nothing found, the form", async () => {
    const refused = new Error("Malli kieltäytyi vastaamasta tähän pyyntöön");
    const finderRefused = await lookupWithSpacing(
      FUND_ISIN,
      FUND_NAME,
      EUR,
      stubFetch(await misses()),
      0,
      { find: finder(refused).find, client: recipeClient(GOOD), referenceMinor: null },
    );
    expect(finderRefused).toMatchObject({ outcome: "form", formReason: "nothing" });

    const modelRefused = await lookupWithSpacing(
      FUND_ISIN,
      FUND_NAME,
      EUR,
      stubFetch(await misses()),
      0,
      {
        find: finder({ url: PAGE_URL, isin: FUND_ISIN }).find,
        client: recipeClient(refused),
        referenceMinor: null,
      },
    );
    expect(modelRefused).toMatchObject({ outcome: "form", formReason: "nothing" });
  });

  test("without `page` a miss is the form, as before", async () => {
    const result = await lookupWithSpacing(FUND_ISIN, FUND_NAME, EUR, stubFetch(await misses()), 0);
    expect(result).toMatchObject({ outcome: "form", formReason: "nothing", pageRecipe: null });
  });
});

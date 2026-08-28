import { describe, expect, test } from "bun:test";

import { parseCurrency } from "../../core/money";
import { lookupInstrument } from "./lookup";
import { figiLookup } from "./openfigi";
import { opSlugFor, resolveOpSlug, stripShareClass } from "./op-slug";

const fixture = (name: string): Promise<string> =>
  Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).text();

/**
 * A fetch stub keyed by substring of the requested URL. Anything not listed
 * throws, so a test that reaches an unexpected endpoint fails loudly rather
 * than silently returning undefined -- and no test here touches the network
 * (test-network-guard.ts enforces that globally).
 */
const stubFetch = (routes: Record<string, { body: string; status?: number }>): typeof fetch =>
  // SAFETY: every call site below passes only a URL and reads only the
  // Response, so this single-argument function covers the whole of fetch as
  // this codebase uses it; the assertion exists because fetch's own type
  // cannot be satisfied structurally without restating its overloads.
  (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    for (const [needle, response] of Object.entries(routes)) {
      if (url.includes(needle)) {
        return new Response(response.body, { status: response.status ?? 200 });
      }
    }
    throw new Error(`odottamaton pyyntö: ${url}`);
  }) as typeof fetch;

describe("figiLookup", () => {
  test("resolves a listed share to its kind and registry name", async () => {
    const body = await fixture("figi-nokia.json");
    expect(await figiLookup("FI0009000681", stubFetch({ openfigi: { body } }))).toEqual({
      name: "NOKIA OYJ",
      kind: "stock",
    });
  });

  test("resolves a Finnish non-listed fund", async () => {
    const body = await fixture("figi-op-maailma.json");
    expect(await figiLookup("FI4000261128", stubFetch({ openfigi: { body } }))).toEqual({
      name: "OP-WORLD INDEX FUND-A EUR",
      kind: "fund",
    });
  });

  test("returns null for a well-formed ISIN the registry does not know", async () => {
    const body = await fixture("figi-unknown.json");
    expect(await figiLookup("FI0000000003", stubFetch({ openfigi: { body } }))).toBeNull();
  });

  test("returns null for a malformed ISIN rather than throwing", async () => {
    const body = await fixture("figi-invalid.json");
    expect(await figiLookup("XX0000000000", stubFetch({ openfigi: { body } }))).toBeNull();
  });

  test("returns null on a non-OK response", async () => {
    expect(
      await figiLookup("FI0009000681", stubFetch({ openfigi: { body: "", status: 503 } })),
    ).toBeNull();
  });
});

describe("opSlugFor", () => {
  test("slugifies a fund name the way OP's own URLs do", () => {
    expect(opSlugFor("OP-Maailma Indeksi A")).toBe("op-maailma-indeksi");
    expect(opSlugFor("OP-MAAILMA INDEKSI A")).toBe("op-maailma-indeksi");
    expect(opSlugFor("OP-Suomi Indeksi")).toBe("op-suomi-indeksi");
  });

  test("drops a share-class suffix but not a word ending in one", () => {
    expect(stripShareClass("OP-Ilmasto A")).toBe("op ilmasto");
    expect(stripShareClass("OP-Ilmasto")).toBe("op ilmasto");
    expect(stripShareClass("OP-Maailma Indeksi (kasvu)")).toBe("op maailma indeksi");
  });
});

describe("resolveOpSlug", () => {
  test("confirms a guessed slug against the page's own ISIN", async () => {
    const body = await fixture("op-fund-maailma.html");
    expect(
      await resolveOpSlug("OP-MAAILMA INDEKSI A", "FI4000261128", stubFetch({ "op.fi": { body } })),
    ).toEqual({ slug: "op-maailma-indeksi", isin: "FI4000261128", name: "OP-MAAILMA INDEKSI A" });
  });

  test("refuses a page whose ISIN is not the one asked for", async () => {
    const body = await fixture("op-fund-maailma.html");
    expect(
      await resolveOpSlug("OP-MAAILMA INDEKSI A", "FI4000315692", stubFetch({ "op.fi": { body } })),
    ).toBeNull();
  });

  test("harvests the ISIN when the import carried none, proving the match by name", async () => {
    const body = await fixture("op-fund-maailma.html");
    expect(
      await resolveOpSlug("OP-MAAILMA INDEKSI A", null, stubFetch({ "op.fi": { body } })),
    ).toEqual({ slug: "op-maailma-indeksi", isin: "FI4000261128", name: "OP-MAAILMA INDEKSI A" });
  });

  test("refuses a page whose title is a different fund", async () => {
    const body = await fixture("op-fund-maailma.html");
    expect(
      await resolveOpSlug("OP-Suomi Indeksi", null, stubFetch({ "op.fi": { body } })),
    ).toBeNull();
  });

  test("returns null when the guessed slug has no page", async () => {
    expect(
      await resolveOpSlug("Ei Olemassa", null, stubFetch({ "op.fi": { body: "", status: 404 } })),
    ).toBeNull();
  });
});

describe("lookupInstrument", () => {
  test("a listed share resolves to a Yahoo ticker and its listing currency", async () => {
    const result = await lookupInstrument(
      "FI0009000681",
      "NOKIA",
      stubFetch({
        openfigi: { body: await fixture("figi-nokia.json") },
        "finance/search": { body: await fixture("yahoo-search-nokia.json") },
        "finance/chart": {
          body: JSON.stringify({ chart: { result: [{ meta: { currency: "EUR" } }] } }),
        },
      }),
    );
    expect(result).toEqual({
      kind: "stock",
      name: "NOKIA OYJ",
      priceSource: "yahoo",
      sourceKey: "NOKIA.HE",
      isin: "FI0009000681",
      listingCurrency: parseCurrency("EUR"),
    });
  });

  test("an ETF's listing currency is reported even when it differs from the holding's", async () => {
    const result = await lookupInstrument(
      "IE00B4L5Y983",
      "IWDA",
      stubFetch({
        openfigi: {
          body: JSON.stringify([
            { data: [{ name: "ISHARES CORE MSCI WORLD", securityType: "ETP" }] },
          ]),
        },
        "finance/search": { body: await fixture("yahoo-search-iwda.json") },
        "finance/chart": {
          body: JSON.stringify({ chart: { result: [{ meta: { currency: "USD" } }] } }),
        },
      }),
    );
    expect(result.kind).toBe("etf");
    expect(result.sourceKey).toBe("IWDA.L");
    expect(result.listingCurrency).toBe(parseCurrency("USD"));
  });

  test("a fund Yahoo has no match for resolves through OP's own page", async () => {
    const result = await lookupInstrument(
      "FI4000261128",
      "OP-MAAILMA INDEKSI A",
      stubFetch({
        openfigi: { body: await fixture("figi-op-maailma.json") },
        "finance/search": { body: await fixture("yahoo-search-none.json") },
        "op.fi": { body: await fixture("op-fund-maailma.html") },
      }),
    );
    expect(result).toEqual({
      kind: "fund",
      name: "OP-WORLD INDEX FUND-A EUR",
      priceSource: "op_fund",
      sourceKey: "op-maailma-indeksi",
      isin: "FI4000261128",
      listingCurrency: null,
    });
  });

  test("an OP paste row with no ISIN at all still resolves, ISIN included", async () => {
    const result = await lookupInstrument(
      null,
      "OP-MAAILMA INDEKSI A",
      stubFetch({ "op.fi": { body: await fixture("op-fund-maailma.html") } }),
    );
    expect(result.priceSource).toBe("op_fund");
    expect(result.sourceKey).toBe("op-maailma-indeksi");
    expect(result.isin).toBe("FI4000261128");
  });

  test("resolves nothing rather than guessing when every source comes up empty", async () => {
    const result = await lookupInstrument(
      "FI0000000003",
      "Tuntematon",
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
    });
  });

  test("a non-fund that Yahoo cannot price is reported as its kind, with no source guessed", async () => {
    const result = await lookupInstrument(
      "FI0009000681",
      "NOKIA",
      stubFetch({
        openfigi: { body: await fixture("figi-nokia.json") },
        "finance/search": { body: await fixture("yahoo-search-none.json") },
      }),
    );
    expect(result.kind).toBe("stock");
    expect(result.priceSource).toBeNull();
    expect(result.sourceKey).toBeNull();
  });

  test("a network failure in one leg does not fail the lookup", async () => {
    const result = await lookupInstrument(
      "FI4000261128",
      "OP-MAAILMA INDEKSI A",
      stubFetch({
        "finance/search": { body: await fixture("yahoo-search-none.json") },
        "op.fi": { body: await fixture("op-fund-maailma.html") },
      }),
    );
    expect(result.priceSource).toBe("op_fund");
    expect(result.name).toBeNull();
  });
});

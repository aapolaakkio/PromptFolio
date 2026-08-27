import { expect, test } from "bun:test";

import { parseCurrency } from "../../core/money";
import { DANSKE_FUND, MANUAL, NORDNET_FUND, OP_FUND, SPANKKI_FUND } from "./funds";
import { SourceNotImplementedError } from "./types";

const fixture = (name: string) => Bun.file(`${import.meta.dir}/fixtures/${name}`).text();

const stubOk = (body: string) => async (): Promise<Response> => new Response(body, { status: 200 });

const EUR = parseCurrency("EUR");
const SEK = parseCurrency("SEK");

/**
 * A synthetic (not fixture-recorded) page carrying the same compound
 * `orderBook`+`navInfo` shape `NORDNET_FUND_PATTERN` matches, for cases
 * that don't need real content -- an invalid NAV value, a rollover date.
 * `slug` must be whatever `sourceKey` the test calls with, since
 * `NORDNET_FUND` cross-checks the matched id against it.
 */
const syntheticNordnetHtml = (slug: string, latestValue: string, previousValue = "1"): string =>
  `<script>window.__initialState__="{\\"instrument\\":{\\"isin\\":\\"XX0000000000\\",\\"orderBook\\":{\\"id\\":\\"${slug}-test\\",\\"currency\\":\\"EUR\\"}},\\"navInfo\\":{\\"latestNav\\":{\\"date\\":\\"2026-08-25\\",\\"value\\":${latestValue}},\\"previousNav\\":{\\"date\\":\\"2026-08-24\\",\\"value\\":${previousValue}}}}";</script>`;

// --- NORDNET_FUND ----------------------------------------------------------
//
// Both fixtures are real (trimmed) bytes recorded 2026-08-27 from
// nordnet.fi's own fund detail pages -- see funds.ts's NORDNET_FUND
// comment for how they were found and verified.

test("nordnet_fund parses the real EUR-fund fixture (Nordnet Suomi Indeksi)", async () => {
  const html = await fixture("nordnet-fund-suomi.html");
  const prices = await NORDNET_FUND.fetch({
    sourceKey: "nordnet-suomi-indeksi-eur-a401761d",
    from: "2026-08-01",
    to: "2026-08-27",
    fetchImpl: stubOk(html),
  });
  expect(prices).toHaveLength(2);
  expect(prices).toContainEqual({ date: "2026-08-25", closeMinor: 36525, currency: EUR });
  expect(prices).toContainEqual({ date: "2026-08-24", closeMinor: 36103, currency: EUR });
});

test("nordnet_fund carries the real SEK-fund fixture's currency through as SEK, not EUR", async () => {
  const html = await fixture("nordnet-fund-sverige.html");
  const prices = await NORDNET_FUND.fetch({
    sourceKey: "nordnet-sverige-index-sek-aa7a9014",
    from: "2026-08-01",
    to: "2026-08-27",
    fetchImpl: stubOk(html),
  });
  expect(prices).toHaveLength(2);
  for (const point of prices) expect(point.currency).toBe(SEK);
  expect(prices).toContainEqual({ date: "2026-08-25", closeMinor: 85868, currency: SEK });
});

test("nordnet_fund filters the two NAV points to the requested range", async () => {
  const html = await fixture("nordnet-fund-suomi.html");
  const onlyLatest = await NORDNET_FUND.fetch({
    sourceKey: "nordnet-suomi-indeksi-eur-a401761d",
    from: "2026-08-25",
    to: "2026-08-25",
    fetchImpl: stubOk(html),
  });
  expect(onlyLatest).toEqual([{ date: "2026-08-25", closeMinor: 36525, currency: EUR }]);

  const none = await NORDNET_FUND.fetch({
    sourceKey: "nordnet-suomi-indeksi-eur-a401761d",
    from: "2020-01-01",
    to: "2020-01-02",
    fetchImpl: stubOk(html),
  });
  expect(none).toEqual([]);
});

test("nordnet_fund throws when the page's NAV block does not belong to the requested fund", async () => {
  const html = await fixture("nordnet-fund-suomi.html");
  await expect(
    NORDNET_FUND.fetch({
      sourceKey: "some-other-fund-zzzzzzzz",
      from: "2026-08-01",
      to: "2026-08-27",
      fetchImpl: stubOk(html),
    }),
  ).rejects.toThrow();
});

test("nordnet_fund throws when the page has no recognisable NAV block", async () => {
  await expect(
    NORDNET_FUND.fetch({
      sourceKey: "x",
      from: "2026-08-01",
      to: "2026-08-27",
      fetchImpl: stubOk("<html><body>not a fund page</body></html>"),
    }),
  ).rejects.toThrow();
});

test("nordnet_fund surfaces a non-200 response as an error", async () => {
  const failing = async (): Promise<Response> => new Response("not found", { status: 404 });
  await expect(
    NORDNET_FUND.fetch({
      sourceKey: "x",
      from: "2026-08-01",
      to: "2026-08-27",
      fetchImpl: failing,
    }),
  ).rejects.toThrow(/404/);
});

// Reproduced live during review against the real fixture with its value
// edited to "0": returned a `FetchedPrice` with `closeMinor: 0` instead of
// throwing, before `requirePositiveMinor` existed. A negative `value` is
// separately unreachable through `NORDNET_FUND_PATTERN` itself (its
// capture group is `[\d.]+`, no minus sign), so only zero needs exercising
// here -- a negative payload fails the regex match instead, one test above.

test("nordnet_fund throws on a zero NAV instead of returning it as a valid price", async () => {
  const html = syntheticNordnetHtml("zzzzzzzz", "0");
  await expect(
    NORDNET_FUND.fetch({
      sourceKey: "test-fund-zzzzzzzz",
      from: "2026-08-01",
      to: "2026-08-27",
      fetchImpl: stubOk(html),
    }),
  ).rejects.toThrow(/epäkelpo hinta/);
});

// --- OP_FUND -----------------------------------------------------------
//
// Fixture is real (trimmed) bytes recorded 2026-08-27 from OP's own fund
// fact-sheet page -- see funds.ts's OP_FUND comment.

test("op_fund parses the real OP-Maailma Indeksi fixture", async () => {
  const html = await fixture("op-maailma-indeksi.html");
  const prices = await OP_FUND.fetch({
    sourceKey: "op-maailma-indeksi",
    from: "2026-08-01",
    to: "2026-08-27",
    fetchImpl: stubOk(html),
  });
  expect(prices).toEqual([{ date: "2026-08-26", closeMinor: 28360, currency: EUR }]);
});

test("op_fund excludes the parsed NAV date when it falls outside the requested range", async () => {
  const html = await fixture("op-maailma-indeksi.html");
  const prices = await OP_FUND.fetch({
    sourceKey: "op-maailma-indeksi",
    from: "2020-01-01",
    to: "2020-01-02",
    fetchImpl: stubOk(html),
  });
  expect(prices).toEqual([]);
});

test("op_fund throws when the page has no NAV row", async () => {
  await expect(
    OP_FUND.fetch({
      sourceKey: "x",
      from: "2026-08-01",
      to: "2026-08-27",
      fetchImpl: stubOk("<html><body>no fact sheet here</body></html>"),
    }),
  ).rejects.toThrow();
});

test("op_fund surfaces a non-200 response as an error", async () => {
  const failing = async (): Promise<Response> => new Response("server error", { status: 500 });
  await expect(
    OP_FUND.fetch({ sourceKey: "x", from: "2026-08-01", to: "2026-08-27", fetchImpl: failing }),
  ).rejects.toThrow(/500/);
});

// Reproduced live during review against the real fixture with its value
// edited to "0,00": returned `closeMinor: 0` instead of throwing, before
// `requirePositiveMinor` existed. `OP_NAV_PATTERN`'s value capture
// (`[\d\s.,]+`) has no minus sign either, so -- like nordnet_fund -- a
// negative value is structurally unreachable through this source and only
// zero needs a dedicated test.

test("op_fund throws on a zero NAV instead of returning it as a valid price", async () => {
  const html = `<dl><dt>Osuuden arvo (26.08.)</dt><dd>0,00 EUR</dd></dl>`;
  await expect(
    OP_FUND.fetch({
      sourceKey: "x",
      from: "2026-08-01",
      to: "2026-08-27",
      fetchImpl: stubOk(html),
    }),
  ).rejects.toThrow(/epäkelpo hinta/);
});

// `inferNavYear`'s rollover branch (`referenceYear - 1`) is the one piece
// of this task flagged as reasoned-but-unverified (see funds.ts's comment
// above `inferNavYear`): the only way OP's yearless "as of" date can be
// *later* than the request's own reference date is a year boundary, e.g.
// requesting on 2 Jan while the page still shows 31 Dec of the year
// before. Not exercised by the real fixture (captured in August), so
// constructed directly rather than left to 100% line coverage to hide an
// untested branch.

test("op_fund infers the previous year for a 31 December NAV requested just after New Year", async () => {
  const html = `<dl><dt>Osuuden arvo (31.12.)</dt><dd>100,00 EUR</dd></dl>`;
  const prices = await OP_FUND.fetch({
    sourceKey: "x",
    from: "2025-01-01",
    to: "2026-01-02",
    fetchImpl: stubOk(html),
  });
  expect(prices).toEqual([{ date: "2025-12-31", closeMinor: 10000, currency: EUR }]);
});

// --- SPANKKI_FUND / DANSKE_FUND -----------------------------------------
//
// Deliberately not implemented -- see funds.ts's comment above
// `notYetImplemented`. Never touches the network, but -- unlike an earlier
// draft, and unlike MANUAL -- does not silently resolve `[]` either: review
// found that indistinguishable from "fetched fine, nothing new today" to a
// caller iterating every configured source. `fetch()` now throws a
// distinct, exported `SourceNotImplementedError` instead, so a caller can
// tell the two apart by `instanceof` alone.

test("spankki_fund and danske_fund throw SourceNotImplementedError without ever calling the network", async () => {
  const fetchImpl = (): Promise<Response> => {
    throw new Error("must not be called");
  };
  const spankki = SPANKKI_FUND.fetch({
    sourceKey: "x",
    from: "2026-08-01",
    to: "2026-08-27",
    fetchImpl,
  });
  await expect(spankki).rejects.toBeInstanceOf(SourceNotImplementedError);
  await expect(spankki).rejects.toMatchObject({ id: "spankki_fund" });

  const danske = DANSKE_FUND.fetch({
    sourceKey: "x",
    from: "2026-08-01",
    to: "2026-08-27",
    fetchImpl,
  });
  await expect(danske).rejects.toBeInstanceOf(SourceNotImplementedError);
  await expect(danske).rejects.toMatchObject({ id: "danske_fund" });

  expect(SPANKKI_FUND.id).toBe("spankki_fund");
  expect(DANSKE_FUND.id).toBe("danske_fund");
});

test("spankki_fund and danske_fund are distinguishable from manual's clean empty result", async () => {
  await expect(
    MANUAL.fetch({ sourceKey: "x", from: "2026-08-01", to: "2026-08-27" }),
  ).resolves.toEqual([]);
  await expect(
    SPANKKI_FUND.fetch({ sourceKey: "x", from: "2026-08-01", to: "2026-08-27" }),
  ).rejects.toBeInstanceOf(SourceNotImplementedError);
});

// --- MANUAL --------------------------------------------------------------

test("manual never calls the network and never returns a price", async () => {
  const fetchImpl = (): Promise<Response> => {
    throw new Error("must not be called");
  };
  await expect(
    MANUAL.fetch({ sourceKey: "x", from: "2026-08-01", to: "2026-08-27", fetchImpl }),
  ).resolves.toEqual([]);
});

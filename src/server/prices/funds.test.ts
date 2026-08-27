import { expect, test } from "bun:test";

import { parseCurrency } from "../../core/money";
import { DANSKE_FUND, MANUAL, NORDNET_FUND, OP_FUND, SPANKKI_FUND } from "./funds";

const fixture = (name: string) => Bun.file(`${import.meta.dir}/fixtures/${name}`).text();

const stubOk = (body: string) => async (): Promise<Response> => new Response(body, { status: 200 });

const EUR = parseCurrency("EUR");
const SEK = parseCurrency("SEK");

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

// --- SPANKKI_FUND / DANSKE_FUND -----------------------------------------
//
// Deliberately not implemented -- see funds.ts's comment above
// `notYetImplemented`. Behaviour must match MANUAL exactly: no network
// call, no prices, ever.

test("spankki_fund and danske_fund behave exactly like manual: no prices, no network call", async () => {
  const fetchImpl = (): Promise<Response> => {
    throw new Error("must not be called");
  };
  await expect(
    SPANKKI_FUND.fetch({ sourceKey: "x", from: "2026-08-01", to: "2026-08-27", fetchImpl }),
  ).resolves.toEqual([]);
  await expect(
    DANSKE_FUND.fetch({ sourceKey: "x", from: "2026-08-01", to: "2026-08-27", fetchImpl }),
  ).resolves.toEqual([]);
  expect(SPANKKI_FUND.id).toBe("spankki_fund");
  expect(DANSKE_FUND.id).toBe("danske_fund");
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

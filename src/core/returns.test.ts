import { test, expect } from "bun:test";
import { valueSeries, xirr, twr, datesBetween, investedSeries } from "./returns";
import type { PriceLookup } from "./returns";
import { investedCashFlows } from "./ledger";
import type { Instrument, Txn, TransactionType, CashFlow } from "./types";
import { parseMoney, parseQuantity, parseFxRate, parseCurrency, formatMoney, EUR } from "./money";

const USD = parseCurrency("USD");

const instrument: Instrument = {
  id: 7,
  isin: "FI0009000681",
  ticker: "NOKIA.HE",
  name: "Nokia",
  kind: "stock",
  currency: EUR,
  priceSource: "yahoo",
  sourceKey: "NOKIA.HE",
};

const usdInstrument: Instrument = {
  id: 9,
  isin: "US0000000009",
  ticker: "USDCO",
  name: "USD Co",
  kind: "stock",
  currency: USD,
  priceSource: "yahoo",
  sourceKey: "USDCO",
};

let nextId = 1;
const txn = (
  type: TransactionType,
  tradeDate: string,
  o: { qty?: string; amount?: string } = {},
): Txn => ({
  id: nextId++,
  accountId: 1,
  instrumentId: o.qty ? 7 : null,
  type,
  tradeDate,
  quantity: parseQuantity(o.qty ?? "0"),
  unitPrice: null,
  amount: parseMoney(o.amount ?? "0", EUR),
  fee: parseMoney("0", EUR),
  tax: parseMoney("0", EUR),
  currency: EUR,
  fxRateEur: parseFxRate("1", EUR),
});

const lookup = (byDate: Record<string, string>): PriceLookup => ({
  priceOn: (_id, date) => {
    const known = Object.keys(byDate)
      .filter((d) => d <= date)
      .sort()
      .at(-1);
    return known ? parseMoney(byDate[known]!, EUR) : null;
  },
  priceDateOn: (_id, date) => {
    const known = Object.keys(byDate)
      .filter((d) => d <= date)
      .sort()
      .at(-1);
    return known ?? null;
  },
  fxOn: () => parseFxRate("1", EUR),
});

test("enumerates every calendar day inclusive", () => {
  expect(datesBetween("2025-01-30", "2025-02-02")).toEqual([
    "2025-01-30",
    "2025-01-31",
    "2025-02-01",
    "2025-02-02",
  ]);
});

test("values a position each day at its latest known price", () => {
  const txns = [txn("BUY", "2025-01-01", { qty: "10", amount: "-1000,00" })];
  const series = valueSeries(
    txns,
    [instrument],
    lookup({ "2025-01-01": "100,00", "2025-01-03": "110,00" }),
    "2025-01-01",
    "2025-01-04",
  );
  expect(series.map((p) => formatMoney(p.valueEur))).toEqual([
    "1000.00",
    "1000.00",
    "1100.00",
    "1100.00",
  ]);
});

test("marks days valued from an older price as stale", () => {
  const txns = [txn("BUY", "2025-01-01", { qty: "10", amount: "-1000,00" })];
  const series = valueSeries(
    txns,
    [instrument],
    lookup({ "2025-01-01": "100,00" }),
    "2025-01-01",
    "2025-01-03",
  );
  expect(series.map((p) => p.stale)).toEqual([false, true, true]);
});

test("values are zero before the first purchase", () => {
  const txns = [txn("BUY", "2025-01-03", { qty: "10", amount: "-1000,00" })];
  const series = valueSeries(
    txns,
    [instrument],
    lookup({ "2025-01-01": "100,00" }),
    "2025-01-01",
    "2025-01-03",
  );
  expect(series.map((p) => formatMoney(p.valueEur))).toEqual(["0.00", "0.00", "1000.00"]);
});

test("converts a USD position through fxOn with correctly rounded EUR value", () => {
  const usdTxn: Txn = {
    id: nextId++,
    accountId: 1,
    instrumentId: 9,
    type: "BUY",
    tradeDate: "2025-01-01",
    quantity: parseQuantity("1"),
    unitPrice: null,
    amount: parseMoney("-100,00", USD),
    fee: parseMoney("0", USD),
    tax: parseMoney("0", USD),
    currency: USD,
    fxRateEur: parseFxRate("0.85005000", USD),
  };
  // Chosen so the exact quotient lands on a rounding tie: half-up gives 85.01,
  // any rounding-down mode would silently give 85.00 instead.
  const usdPrices: PriceLookup = {
    priceOn: (_id, date) => (date >= "2025-01-01" ? parseMoney("100,00", USD) : null),
    priceDateOn: (_id, date) => (date >= "2025-01-01" ? "2025-01-01" : null),
    fxOn: () => parseFxRate("0.85005000", USD),
  };
  const series = valueSeries([usdTxn], [usdInstrument], usdPrices, "2025-01-01", "2025-01-01");
  expect(series.map((p) => formatMoney(p.valueEur))).toEqual(["85.01"]);
});

test("an instrument with no known price contributes nothing and marks the day stale", () => {
  const txns = [txn("BUY", "2025-01-01", { qty: "10", amount: "-1000,00" })];
  const neverPriced: PriceLookup = {
    priceOn: () => null,
    priceDateOn: () => null,
    fxOn: () => parseFxRate("1", EUR),
  };
  const series = valueSeries(txns, [instrument], neverPriced, "2025-01-01", "2025-01-01");
  // Superseded: this used to report 0,00 EUR and exclude the holding. A holding with
  // no price *yet* is now carried at its cost basis -- what was paid is the honest
  // value of an IPO subscription, a delisted line, or a fund whose provider serves
  // only recent history -- and reported as cost-valued rather than as a hole.
  expect(series.map((p) => formatMoney(p.valueEur))).toEqual(["1000.00"]);
  expect(series.map((p) => p.stale)).toEqual([true]);
  expect(series.map((p) => p.costValuedInstrumentIds)).toEqual([[7]]);
  // C1's requirement still holds, now met by costValuedInstrumentIds above: the
  // caller can still tell how this day's number was arrived at. Nothing is
  // *excluded* any more, because nothing is missing -- the holding is valued, just
  // at cost rather than at a market price.
  expect(series[0]!.excludedInstrumentIds).toEqual([]);
});

test("a priced USD instrument with no known fx rate contributes nothing and marks the day stale", () => {
  const usdTxn: Txn = {
    id: nextId++,
    accountId: 1,
    instrumentId: 9,
    type: "BUY",
    tradeDate: "2025-01-01",
    quantity: parseQuantity("1"),
    unitPrice: null,
    amount: parseMoney("-100,00", USD),
    fee: parseMoney("0", USD),
    tax: parseMoney("0", USD),
    currency: USD,
    fxRateEur: parseFxRate("0.85005000", USD),
  };
  const noFxRate: PriceLookup = {
    priceOn: () => parseMoney("100,00", USD),
    priceDateOn: () => "2025-01-01",
    fxOn: () => null,
  };
  const series = valueSeries([usdTxn], [usdInstrument], noFxRate, "2025-01-01", "2025-01-01");
  expect(series.map((p) => formatMoney(p.valueEur))).toEqual(["0.00"]);
  expect(series.map((p) => p.stale)).toEqual([true]);
  // C1: same as the no-price case above -- a real, dated price exists here, but the
  // missing fx rate must still exclude (not zero-fabricate) this holding, visibly.
  expect(series[0]!.excludedInstrumentIds).toEqual([9]);
});

test("a SELL with no matching prior BUY drives the position negative, and that day's value excludes it rather than going negative", () => {
  // No prior BUY at all -- e.g. one page of a paged OP import that only
  // contains the SELL, with the matching BUY on a page not yet imported.
  // positionsAt() (core/ledger.ts) still reports the raw signed quantity
  // (-10), which is correct ledger state, but valueSeries must not turn
  // that into a -1000.00 "value".
  const txns = [txn("SELL", "2025-01-01", { qty: "10", amount: "1000,00" })];
  const series = valueSeries(
    txns,
    [instrument],
    lookup({ "2025-01-01": "100,00" }),
    "2025-01-01",
    "2025-01-01",
  );
  expect(series.map((p) => formatMoney(p.valueEur))).toEqual(["0.00"]);
  expect(series[0]!.excludedInstrumentIds).toEqual([7]);
  // C5 fix: this day's value is missing a real holding -- exactly the same fact
  // `stale` exists to flag for the missing-price and missing-fx branches, so this
  // branch must set it too. (Previously this asserted `false`, on the theory that
  // "the price is current, only the position is wrong" excused it -- that theory is
  // exactly what let this excluded holding poison `twr` silently; see returns.ts's
  // `twr` doc.)
  expect(series[0]!.stale).toBe(true);
});

test("xirr recovers a known 10% annual return", () => {
  const flows: CashFlow[] = [{ date: "2024-01-01", amountEur: parseMoney("-1000,00", EUR) }];
  const final: CashFlow = { date: "2025-01-01", amountEur: parseMoney("1100,00", EUR) };
  expect(xirr(flows, final)).toBeCloseTo(0.1, 4);
});

test("xirr handles multiple irregular contributions", () => {
  const flows: CashFlow[] = [
    { date: "2024-01-01", amountEur: parseMoney("-1000,00", EUR) },
    { date: "2024-07-01", amountEur: parseMoney("-500,00", EUR) },
  ];
  const final: CashFlow = { date: "2025-01-01", amountEur: parseMoney("1650,00", EUR) };
  const rate = xirr(flows, final);
  expect(rate).toBeGreaterThan(0.09);
  expect(rate).toBeLessThan(0.13);
});

test("xirr converges on a loss", () => {
  const flows: CashFlow[] = [{ date: "2024-01-01", amountEur: parseMoney("-1000,00", EUR) }];
  const final: CashFlow = { date: "2025-01-01", amountEur: parseMoney("800,00", EUR) };
  expect(xirr(flows, final)).toBeCloseTo(-0.2, 4);
});

test("xirr throws rather than returning a bogus rate when all cash flows share a sign", () => {
  const flows: CashFlow[] = [{ date: "2024-01-01", amountEur: parseMoney("-1000,00", EUR) }];
  const final: CashFlow = { date: "2025-01-01", amountEur: parseMoney("-50,00", EUR) };
  expect(() => xirr(flows, final)).toThrow(/sign/i);
});

test("xirr falls back to bisection when Newton-Raphson fails to converge", () => {
  // A ~90% loss over a long (~4.1 year) window has an NPV curve so steep near the
  // rate=0.1 seed that Newton's very first tangent-line step overshoots past
  // rate = -1 (outside the domain of (1+rate)^t), so it must fall back to
  // bisection to find the true rate.
  const flows: CashFlow[] = [{ date: "2024-01-01", amountEur: parseMoney("-1000,00", EUR) }];
  const final: CashFlow = { date: "2028-02-09", amountEur: parseMoney("100,00", EUR) };
  expect(xirr(flows, final)).toBeCloseTo(-0.4292, 3);
});

// This test used to hand-build its `values`/`flows` instead of deriving them from
// valueSeries()/investedCashFlows() the way every real caller does, and it encoded exactly
// the mismatch that made TWR wrong for any portfolio that deposits and invests (see
// `twr`'s doc in returns.ts and `investedCashFlows`'s doc in ledger.ts): a 1000.00 deposit
// dated 2024-07-01, fed as a flow, against a `values[1]` of 1400.00 for that same date that
// was hand-picked to NOT yet include it -- i.e. it assumed a deposit-shaped flow arriving
// strictly after that day's valuation. Real `valueSeries` points already include any trade
// dated exactly that day, so a real invested flow describes the opposite timing. Rebuilt
// below from actual txns run through the real valueSeries()/investedCashFlows() pair.
test("twr ignores the timing of a mid-year deposit that gets invested immediately", () => {
  // 5 units bought 2024-01-01 at 100.00 (500.00). Price stays flat at 100.00 until it
  // doubles to 200.00 on 2024-12-01. A second deposit of 500.00 is fully invested on
  // 2024-07-01 -- still at 100.00, so it changes the portfolio's size, not its price
  // exposure. The instrument itself doubles over the year; TWR must report that ~100%
  // regardless of when the second deposit landed.
  const txns: Txn[] = [
    txn("BUY", "2024-01-01", { qty: "5", amount: "-500,00" }),
    txn("BUY", "2024-07-01", { qty: "5", amount: "-500,00" }),
  ];
  const values = valueSeries(
    txns,
    [instrument],
    lookup({ "2024-01-01": "100,00", "2024-12-01": "200,00" }),
    "2024-01-01",
    "2024-12-31",
  );
  const flows = investedCashFlows(txns);
  expect(twr(values, flows)).toBeCloseTo(1.0, 6);
});

// C4 regressions -- verified against the real valueSeries()/investedCashFlows() pipeline,
// the exact shape every ledger has (deposit, then invest it), reproducing the two repro
// scenarios from the C4 report.

test("twr is exactly 0 for three flat-price monthly deposits, each invested the same day", () => {
  const txns: Txn[] = [
    txn("BUY", "2024-01-01", { qty: "10", amount: "-1000,00" }),
    txn("BUY", "2024-02-01", { qty: "10", amount: "-1000,00" }),
    txn("BUY", "2024-03-01", { qty: "10", amount: "-1000,00" }),
  ];
  const values = valueSeries(
    txns,
    [instrument],
    lookup({ "2024-01-01": "100,00" }),
    "2024-01-01",
    "2024-04-01",
  );
  const flows = investedCashFlows(txns);
  expect(twr(values, flows)).toBeCloseTo(0, 9);
});

test("twr is exactly +25% for a single deposit, invested the same day, on a 25% price gain", () => {
  const txns: Txn[] = [txn("BUY", "2024-01-01", { qty: "1", amount: "-80,00" })];
  const values = valueSeries(
    txns,
    [instrument],
    lookup({ "2024-01-01": "80,00", "2025-01-01": "100,00" }),
    "2024-01-01",
    "2025-01-01",
  );
  const flows = investedCashFlows(txns);
  expect(twr(values, flows)).toBeCloseTo(0.25, 9);
});

test("twr of a flat portfolio is zero", () => {
  const values = [
    {
      date: "2024-01-01",
      valueEur: parseMoney("1000,00", EUR),
      stale: false,
      excludedInstrumentIds: [],
      costValuedInstrumentIds: [],
    },
    {
      date: "2024-12-31",
      valueEur: parseMoney("1000,00", EUR),
      stale: false,
      excludedInstrumentIds: [],
      costValuedInstrumentIds: [],
    },
  ];
  expect(twr(values, [])).toBeCloseTo(0, 6);
});

// --- C3 regression: a deposit that predates its first investment must not report -100% ---

const point = (date: string, valueEur: string) => ({
  date,
  valueEur: parseMoney(valueEur, EUR),
  stale: false,
  excludedInstrumentIds: [],
  costValuedInstrumentIds: [],
});

test("twr does not collapse to -100% when a deposit precedes the first purchase (the normal shape of every ledger)", () => {
  // Reproduces the exact C3 report: a 1000.00 deposit on 2024-01-01, no purchase until
  // 2024-01-05 (10 units @ 100.00). `valueSeries` excludes uninvested cash (§7), so the
  // invested value is 0.00 for every day up to and including 2024-01-04 -- the old code
  // added the deposit to that zero base anyway, producing a `0 / 1000` = 0 factor on the
  // very first sub-period that then poisoned the whole chained product, however the
  // position went on to perform (`chained` never recovers from one 0 factor). Here the
  // position gains 10% (1000.00 -> 1100.00) after being funded; the fixed twr() must
  // report that 10%, not -100%.
  const values = [
    point("2024-01-01", "0,00"),
    point("2024-01-02", "0,00"),
    point("2024-01-03", "0,00"),
    point("2024-01-04", "0,00"),
    point("2024-01-05", "1000,00"),
    point("2024-01-06", "1100,00"),
  ];
  const flows: CashFlow[] = [{ date: "2024-01-01", amountEur: parseMoney("1000,00", EUR) }];
  expect(twr(values, flows)).toBeCloseTo(0.1, 6);
});

// --- C5 regression: an excluded instrument (unpriceable, unconvertible, or an unmatched
// disposal) must not collapse `twr` to a fabricated +/-100%, whatever the current chained
// product happens to be doing when it hits that day. Every scenario below is run through the
// real valueSeries()/investedCashFlows() pair, not hand-built points, so it reproduces the
// exact mechanism the bug report described: an excluded day's value drops out of `valueEur`
// while a same-day flow keeps moving, corrupting `end = value - flow` and then poisoning
// `chained` (a running product) for every day after it.

const instrumentB: Instrument = {
  id: 8,
  isin: "SE0009000682",
  ticker: "B",
  name: "Toinen rahasto",
  kind: "fund",
  currency: EUR,
  priceSource: "manual",
  sourceKey: "B",
};

/** Builds a real (non-instrument-7) txn for the multi-instrument C5 scenarios below. */
const txnFor = (
  type: TransactionType,
  instrumentId: number,
  tradeDate: string,
  o: { qty?: string; amount?: string } = {},
): Txn => ({
  id: nextId++,
  accountId: 1,
  instrumentId,
  type,
  tradeDate,
  quantity: parseQuantity(o.qty ?? "0"),
  unitPrice: null,
  amount: parseMoney(o.amount ?? "0", EUR),
  fee: parseMoney("0", EUR),
  tax: parseMoney("0", EUR),
  currency: EUR,
  fxRateEur: parseFxRate("1", EUR),
});

/** A PriceLookup where each instrument id has its own (possibly empty) date->price map. */
const multiLookup = (byInstrument: Record<number, Record<string, string>>): PriceLookup => ({
  priceOn: (id, date) => {
    const byDate = byInstrument[id];
    if (!byDate) return null;
    const known = Object.keys(byDate)
      .filter((d) => d <= date)
      .sort()
      .at(-1);
    return known ? parseMoney(byDate[known]!, EUR) : null;
  },
  priceDateOn: (id, date) => {
    const byDate = byInstrument[id];
    if (!byDate) return null;
    const known = Object.keys(byDate)
      .filter((d) => d <= date)
      .sort()
      .at(-1);
    return known ?? null;
  },
  fxOn: () => parseFxRate("1", EUR),
});

test("C5 repro 1: a second holding that is never priced does not collapse a flat portfolio to -100% -- it reports null (see twr's doc for the skip-vs-null decision)", () => {
  // Instrument 7 is bought and priced flat all along (a genuinely flat position).
  // Instrument 8 is bought the same day but never gets a price row at all (e.g. an
  // S-Pankki/Danske manual fund set up before its first NAV entry, spec §10a A5) --
  // excluded from every single day of the series, forever, in this reproduction.
  const txns = [
    txn("BUY", "2024-01-01", { qty: "10", amount: "-1000,00" }),
    txnFor("BUY", 8, "2024-01-01", { qty: "5", amount: "-500,00" }),
  ];
  const prices = multiLookup({ 7: { "2024-01-01": "100,00" } });
  const series = valueSeries(txns, [instrument, instrumentB], prices, "2024-01-01", "2024-01-10");
  const flows = investedCashFlows(txns);
  // Before the C5 fix this chained to exactly -1 (-100%): instrument 8's BUY still
  // counted as an inbound flow while its value dropped out of `valueEur`, so
  // `end = value - flow` went to zero on day one and poisoned the running product
  // for the rest of the series.
  //
  // It then reported null, because every sub-period was skipped. Now instrument 8
  // is carried at cost throughout, so nothing is missing and nothing jumps: the
  // portfolio really is flat across the window and 0% is the true answer. The
  // property that matters is unchanged -- a holding no source prices must never
  // manufacture a -100% return.
  expect(twr(series, flows)).toBe(0);
});

test("C5 repro 2: an unmatched disposal (SELL with no prior BUY in this ledger) does not report a fabricated +100% -- the corrupted sub-period is skipped", () => {
  // A single page of a paged OP import: this ledger only ever sees a SELL of 20
  // units against a BUY of just 10 -- `positionsAt` correctly reports the raw net
  // (-10, an unmatched disposal), which `valueSeries` excludes rather than pricing
  // as a fabricated negative value (see returns.ts's `valueSeries` doc).
  const txns = [
    txn("BUY", "2024-01-01", { qty: "10", amount: "-1000,00" }),
    txn("SELL", "2024-01-05", { qty: "20", amount: "2000,00" }),
  ];
  const prices = lookup({ "2024-01-01": "100,00", "2024-01-05": "100,00" });
  const series = valueSeries(txns, [instrument], prices, "2024-01-01", "2024-01-05");
  const flows = investedCashFlows(txns);
  // Before the C5 fix this chained to exactly +1 (+100%): the SELL's proceeds are a
  // NEGATIVE flow in twr's sign convention (money leaving positions), so
  // `end = 0 - (-2000.00)` fabricated a 2000.00 "value" out of an excluded (0.00)
  // day. With the excluded day's sub-period skipped instead, only the three flat,
  // uncorrupted days before it ever contribute a factor, so the honest answer here
  // is flat (0%), not a fabricated double-up.
  expect(twr(series, flows)).toBeCloseTo(0, 9);
});

test("C5 repro 3: the same unmatched disposal, alongside a second, healthy holding, still reports the healthy holding's real (flat) return rather than a fabricated +50%", () => {
  const txns = [
    txn("BUY", "2024-01-01", { qty: "10", amount: "-1000,00" }),
    txn("SELL", "2024-01-05", { qty: "20", amount: "2000,00" }),
    txnFor("BUY", 8, "2024-01-01", { qty: "10", amount: "-1000,00" }),
  ];
  const prices = multiLookup({
    7: { "2024-01-01": "100,00", "2024-01-05": "100,00" },
    8: { "2024-01-01": "100,00", "2024-01-05": "100,00" },
  });
  const series = valueSeries(txns, [instrument, instrumentB], prices, "2024-01-01", "2024-01-05");
  const flows = investedCashFlows(txns);
  // Before the C5 fix this chained to +0.5 (+50%): the same fabricated 2000.00
  // "value" from repro 2 above, now averaged against instrument 8's real 1000.00
  // holding on the excluded day. Skipping that one corrupted sub-period leaves the
  // three flat, uncorrupted days -- both instruments held flat throughout -- so the
  // honest answer is 0%, not a fabricated gain built on a fictitious number.
  expect(twr(series, flows)).toBeCloseTo(0, 9);
});

test("C5: a run of exclusion-skipped sub-periods that is a small minority of the series still returns a real number, not null", () => {
  // One single excluded day out of many good ones must not throw the whole
  // computation away -- `null` is reserved for when exclusion-driven skips are the
  // *majority* of what would otherwise have contributed a factor (see twr's doc).
  // Reuses repro 2's shape but extends the series well past the one bad day with
  // more flat, fully-priced days, so uncorrupted periods clearly outnumber it.
  const txns = [
    txn("BUY", "2024-01-01", { qty: "10", amount: "-1000,00" }),
    txn("SELL", "2024-01-05", { qty: "20", amount: "2000,00" }),
    txn("BUY", "2024-01-06", { qty: "10", amount: "-1000,00" }),
  ];
  const prices = lookup({
    "2024-01-01": "100,00",
    "2024-01-05": "100,00",
    "2024-01-06": "100,00",
    "2024-01-10": "100,00",
  });
  const series = valueSeries(txns, [instrument], prices, "2024-01-01", "2024-01-10");
  const flows = investedCashFlows(txns);
  expect(twr(series, flows)).not.toBeNull();
  expect(twr(series, flows)).toBeCloseTo(0, 9);
});

// --- A distinct, pre-existing gap this fix does NOT close (documented, not silent) ---

test("KNOWN GAP: a whole position transferred out in kind still collapses TWR to -100%, because TRANSFER_OUT carries no cash flow for investedCashFlows to describe -- see ledger.ts's own doc on investedCashFlows for why", () => {
  // Distinct from every C5 repro above: `valueSeries` does NOT exclude this day at
  // all (no negative position, no missing price/fx -- the instrument is fully,
  // correctly priced right up to the transfer). The position simply, legitimately,
  // goes to 0.00 once every unit is transferred out. `investedCashFlows` deliberately
  // excludes TRANSFER_IN/TRANSFER_OUT (they carry no `amount` to size a flow with --
  // see that function's own doc), so this real drop to zero has no offsetting flow to
  // explain it, `end` lands on exactly 0, and the chained product is poisoned exactly
  // like C3/C5 guard against -- but neither guard fires here, because neither a zero
  // *start* nor an *excluded* endpoint is what's happening. Fixing this would mean
  // pricing the transferred lot into `investedCashFlows` itself (it needs a
  // `PriceLookup` it does not currently take) -- a separate, larger change than the
  // three-part C5 fix this test suite otherwise verifies, called out here rather than
  // silently left unverified.
  const txns = [
    txn("BUY", "2024-01-01", { qty: "10", amount: "-1000,00" }),
    txn("TRANSFER_OUT", "2024-01-05", { qty: "10" }),
  ];
  const prices = lookup({ "2024-01-01": "100,00", "2024-01-05": "100,00" });
  const series = valueSeries(txns, [instrument], prices, "2024-01-01", "2024-01-05");
  const flows = investedCashFlows(txns);
  expect(twr(series, flows)).toBe(-1);
});

// Price history is served split-adjusted: a provider quotes a share at a hundred
// times its raw price of the day, because the whole series is stated in
// post-split terms. The ledger keeps the raw counts actually held, so multiplying
// one by the other valued pre-split shares at post-split prices -- a hundredfold
// overstatement for a 1:100 reverse split, vanishing on the split date and
// reading as a large one-day portfolio loss.
test("a pre-split holding is valued as the post-split shares it became", () => {
  const txns = [
    txnFor("BUY", 7, "2024-01-01", { qty: "1740", amount: "-1740,00" }),
    txnFor("SPLIT", 7, "2024-03-21", { qty: "18" }),
  ];
  // One continuous, split-adjusted series -- no discontinuity across the split,
  // exactly as the real one behaves (2,99 EUR before, 2,93 EUR after).
  const prices = multiLookup({ 7: { "2024-01-01": "3,00" } });
  const series = valueSeries(txns, [instrument], prices, "2024-03-20", "2024-03-21");

  // 1 000 raw shares are 10 in the price series' terms: 10 x 3,00 = 30,00, both
  // before and after. Unadjusted this read 3 000,00 EUR and then collapsed to 30.
  expect(series.map((p) => formatMoney(p.valueEur))).toEqual(["54.00", "54.00"]);
});

test("an ordinary forward split is adjusted the same way, and a date after it is untouched", () => {
  const txns = [
    txnFor("BUY", 7, "2024-01-01", { qty: "10", amount: "-1000,00" }),
    txnFor("SPLIT", 7, "2024-06-01", { qty: "40" }),
  ];
  const prices = multiLookup({ 7: { "2024-01-01": "25,00" } });
  const series = valueSeries(txns, [instrument], prices, "2024-05-31", "2024-06-01");
  // 10 shares before a 1:4 split are 40 in adjusted terms: 40 x 25,00 = 1 000,00.
  expect(series.map((p) => formatMoney(p.valueEur))).toEqual(["1000.00", "1000.00"]);
});

test("a holding that never split is valued from its raw quantity", () => {
  const txns = [txnFor("BUY", 7, "2024-01-01", { qty: "10", amount: "-1000,00" })];
  const prices = multiLookup({ 7: { "2024-01-01": "110,00" } });
  const series = valueSeries(txns, [instrument], prices, "2024-01-01", "2024-01-01");
  expect(series.map((p) => formatMoney(p.valueEur))).toEqual(["1100.00"]);
});

test("investedSeries carries what has been put in, and takes back what a sale returned", () => {
  const bought = txn("BUY", "2025-01-10", { qty: "10", amount: "-1000,00" });
  const sold = txn("SELL", "2025-01-20", { qty: "5", amount: "600,00" });
  const series = investedSeries([bought, sold], "2025-01-09", "2025-01-21");
  const on = (date: string) => series.find((point) => point.date === date)!;

  // Nothing before the purchase, the full cost after it, and less again once
  // half came back out -- the same flows XIRR reads, so the two cannot
  // disagree about what counts as invested.
  expect(formatMoney(on("2025-01-09").investedEur)).toBe("0.00");
  expect(formatMoney(on("2025-01-10").investedEur)).toBe("1000.00");
  expect(formatMoney(on("2025-01-19").investedEur)).toBe("1000.00");
  expect(formatMoney(on("2025-01-20").investedEur)).toBe("400.00");
});

test("investedSeries returns one point per day, including days nothing happened", () => {
  // The chart draws it against valueSeries, which is also one point per day; a
  // sparse series would misalign the two lines.
  expect(investedSeries([], "2025-01-01", "2025-01-05")).toHaveLength(5);
});

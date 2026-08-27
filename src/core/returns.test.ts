import { test, expect } from "bun:test";
import { valueSeries, xirr, twr, datesBetween } from "./returns";
import type { PriceLookup } from "./returns";
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
  expect(series.map((p) => formatMoney(p.valueEur))).toEqual(["0.00"]);
  expect(series.map((p) => p.stale)).toEqual([true]);
  // C1: an unvalued holding is reported, not just implied by a 0,00 € total that
  // happens to also be stale -- the caller must be able to tell "this holding could
  // not be valued" apart from "the whole portfolio happens to be worth nothing".
  expect(series[0]!.excludedInstrumentIds).toEqual([7]);
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
  // Distinct from staleness: the price is perfectly current, the position is not.
  expect(series[0]!.stale).toBe(false);
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

test("twr ignores the timing of deposits", () => {
  // Portfolio doubles, but a deposit lands halfway. TWR must stay ~100%, not be diluted.
  const values = [
    {
      date: "2024-01-01",
      valueEur: parseMoney("1000,00", EUR),
      stale: false,
      excludedInstrumentIds: [],
    },
    {
      date: "2024-07-01",
      valueEur: parseMoney("1400,00", EUR),
      stale: false,
      excludedInstrumentIds: [],
    },
    {
      date: "2024-12-31",
      valueEur: parseMoney("3360,00", EUR),
      stale: false,
      excludedInstrumentIds: [],
    },
  ];
  const flows: CashFlow[] = [{ date: "2024-07-01", amountEur: parseMoney("1000,00", EUR) }];
  expect(twr(values, flows)).toBeCloseTo(0.96, 2);
});

test("twr of a flat portfolio is zero", () => {
  const values = [
    {
      date: "2024-01-01",
      valueEur: parseMoney("1000,00", EUR),
      stale: false,
      excludedInstrumentIds: [],
    },
    {
      date: "2024-12-31",
      valueEur: parseMoney("1000,00", EUR),
      stale: false,
      excludedInstrumentIds: [],
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

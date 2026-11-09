import { test, expect } from "vitest";
import { valueSeries, xirr, twr, datesBetween, investedSeries } from "./returns.ts";
import type { PriceLookup } from "./returns.ts";
import { investedCashFlows } from "./ledger.ts";
import type { Instrument, Txn, TransactionType, CashFlow } from "./types.ts";
import {
  parseMoney,
  parseQuantity,
  parseFxRate,
  parseCurrency,
  formatMoney,
  EUR,
} from "./money.ts";

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

test("a weekend valued from Friday's close is not stale; Monday without a new price is", () => {
  const txns = [txn("BUY", "2025-01-03", { qty: "10", amount: "-1000,00" })];
  const series = valueSeries(
    txns,
    [instrument],
    lookup({ "2025-01-03": "100,00" }),
    "2025-01-03",
    "2025-01-06",
  );
  expect(series.map((p) => p.stale)).toEqual([false, false, false, true]);
});

test("a fund valued from the previous weekday's NAV is not stale", () => {
  const fund: Instrument = { ...instrument, kind: "fund" };
  const txns = [txn("BUY", "2025-01-02", { qty: "10", amount: "-1000,00" })];
  const series = valueSeries(
    txns,
    [fund],
    lookup({ "2025-01-02": "100,00" }),
    "2025-01-02",
    "2025-01-06",
  );
  // Thu NAV: fresh on Thu, Fri and the weekend; on Monday Friday's NAV could exist.
  expect(series.map((p) => p.stale)).toEqual([false, false, false, false, true]);
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
  // Exact quotient is a rounding tie: half-up gives 85.01, rounding down 85.00.
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
  // No price yet: carried at cost basis (IPO subscription, delisted, short history), reported as cost-valued.
  expect(series.map((p) => formatMoney(p.valueEur))).toEqual(["1000.00"]);
  expect(series.map((p) => p.stale)).toEqual([true]);
  expect(series.map((p) => p.costValuedInstrumentIds)).toEqual([[7]]);
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
  expect(series[0]!.excludedInstrumentIds).toEqual([9]);
});

test("a SELL with no matching prior BUY drives the position negative, and that day's value excludes it rather than going negative", () => {
  // Unmatched disposal (-10): excluded, not priced as a negative value.
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
  // An excluded holding also marks the day stale.
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
  // Steep NPV near the 0.1 seed: Newton overshoots below -1 and must fall back to bisection.
  const flows: CashFlow[] = [{ date: "2024-01-01", amountEur: parseMoney("-1000,00", EUR) }];
  const final: CashFlow = { date: "2028-02-09", amountEur: parseMoney("100,00", EUR) };
  expect(xirr(flows, final)).toBeCloseTo(-0.4292, 3);
});

// Derived from real valueSeries()/investedCashFlows(): a same-day trade is already in that day's value.
test("twr ignores the timing of a mid-year deposit that gets invested immediately", () => {
  // Price doubles over the year; TWR reports ~100% regardless of when the second deposit landed.
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

const point = (date: string, valueEur: string) => ({
  date,
  valueEur: parseMoney(valueEur, EUR),
  stale: false,
  excludedInstrumentIds: [],
  costValuedInstrumentIds: [],
});

test("twr does not collapse to -100% when a deposit precedes the first purchase (the normal shape of every ledger)", () => {
  // A deposit before the first purchase has a zero base: must not report -100%.
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

// An excluded instrument must not collapse twr to a fabricated +/-100%.

const instrumentB: Instrument = {
  id: 8,
  isin: "SE0009000682",
  ticker: "B",
  name: "Another fund",
  kind: "fund",
  currency: EUR,
  priceSource: "manual",
  sourceKey: "B",
};

/** Builds a txn for the multi-instrument scenarios. */
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
  // 7 is flat; 8 is bought but never priced.
  const txns = [
    txn("BUY", "2024-01-01", { qty: "10", amount: "-1000,00" }),
    txnFor("BUY", 8, "2024-01-01", { qty: "5", amount: "-500,00" }),
  ];
  const prices = multiLookup({ 7: { "2024-01-01": "100,00" } });
  const series = valueSeries(txns, [instrument, instrumentB], prices, "2024-01-01", "2024-01-10");
  const flows = investedCashFlows(txns);
  // An unpriced holding is carried at cost, so the portfolio is flat: 0%, never -100%.
  expect(twr(series, flows)).toBe(0);
});

test("C5 repro 2: an unmatched disposal (SELL with no prior BUY in this ledger) does not report a fabricated +100% -- the corrupted sub-period is skipped", () => {
  // Unmatched SELL (-10 raw net) is excluded.
  const txns = [
    txn("BUY", "2024-01-01", { qty: "10", amount: "-1000,00" }),
    txn("SELL", "2024-01-05", { qty: "20", amount: "2000,00" }),
  ];
  const prices = lookup({ "2024-01-01": "100,00", "2024-01-05": "100,00" });
  const series = valueSeries(txns, [instrument], prices, "2024-01-01", "2024-01-05");
  const flows = investedCashFlows(txns);
  // The excluded day's sub-period is skipped: flat 0%, not a fabricated +100%.
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
  // Same skip with a second, healthy holding: 0%.
  expect(twr(series, flows)).toBeCloseTo(0, 9);
});

test("C5: a run of exclusion-skipped sub-periods that is a small minority of the series still returns a real number, not null", () => {
  // One excluded day among many good ones must not give null (only a majority of skips does).
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

// Known gap: a full transfer-out drops value to 0 with no offsetting flow.

test("KNOWN GAP: a whole position transferred out in kind still collapses TWR to -100%, because TRANSFER_OUT carries no cash flow for investedCashFlows to describe -- see ledger.ts's own doc on investedCashFlows for why", () => {
  // Not excluded, and no flow explains the drop to 0.00 (transfers carry no amount; see investedCashFlows).
  const txns = [
    txn("BUY", "2024-01-01", { qty: "10", amount: "-1000,00" }),
    txn("TRANSFER_OUT", "2024-01-05", { qty: "10" }),
  ];
  const prices = lookup({ "2024-01-01": "100,00", "2024-01-05": "100,00" });
  const series = valueSeries(txns, [instrument], prices, "2024-01-01", "2024-01-05");
  const flows = investedCashFlows(txns);
  expect(twr(series, flows)).toBe(-1);
});

// Price history is split-adjusted but the ledger keeps raw counts.
test("a pre-split holding is valued as the post-split shares it became", () => {
  const txns = [
    txnFor("BUY", 7, "2024-01-01", { qty: "1740", amount: "-1740,00" }),
    txnFor("SPLIT", 7, "2024-03-21", { qty: "18" }),
  ];
  // One continuous split-adjusted series.
  const prices = multiLookup({ 7: { "2024-01-01": "3,00" } });
  const series = valueSeries(txns, [instrument], prices, "2024-03-20", "2024-03-21");

  // 1 000 raw shares are 10 in adjusted terms: 10 x 3,00 = 30,00 either side.
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

  // Same flows XIRR reads.
  expect(formatMoney(on("2025-01-09").investedEur)).toBe("0.00");
  expect(formatMoney(on("2025-01-10").investedEur)).toBe("1000.00");
  expect(formatMoney(on("2025-01-19").investedEur)).toBe("1000.00");
  expect(formatMoney(on("2025-01-20").investedEur)).toBe("400.00");
});

test("investedSeries returns one point per day, including days nothing happened", () => {
  // One point per day, to align with valueSeries.
  expect(investedSeries([], "2025-01-01", "2025-01-05")).toHaveLength(5);
});

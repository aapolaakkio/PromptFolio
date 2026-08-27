import { test, expect } from "bun:test";
import { valueSeries, xirr, twr, datesBetween } from "./returns";
import type { PriceLookup } from "./returns";
import type { Instrument, Txn, TransactionType, CashFlow } from "./types";
import { parseMoney, parseQuantity, parseFxRate, formatMoney } from "./money";

const instrument: Instrument = {
  id: 7,
  isin: "FI0009000681",
  ticker: "NOKIA.HE",
  name: "Nokia",
  kind: "stock",
  currency: "EUR",
  priceSource: "yahoo",
  sourceKey: "NOKIA.HE",
};

const usdInstrument: Instrument = {
  id: 9,
  isin: "US0000000009",
  ticker: "USDCO",
  name: "USD Co",
  kind: "stock",
  currency: "USD",
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
  amount: parseMoney(o.amount ?? "0", "EUR"),
  fee: parseMoney("0", "EUR"),
  tax: parseMoney("0", "EUR"),
  currency: "EUR",
  fxRateEur: parseFxRate("1", "EUR"),
});

const lookup = (byDate: Record<string, string>): PriceLookup => ({
  priceOn: (_id, date) => {
    const known = Object.keys(byDate)
      .filter((d) => d <= date)
      .sort()
      .at(-1);
    return known ? parseMoney(byDate[known]!, "EUR") : null;
  },
  priceDateOn: (_id, date) => {
    const known = Object.keys(byDate)
      .filter((d) => d <= date)
      .sort()
      .at(-1);
    return known ?? null;
  },
  fxOn: () => parseFxRate("1", "EUR"),
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
    amount: parseMoney("-100,00", "USD"),
    fee: parseMoney("0", "USD"),
    tax: parseMoney("0", "USD"),
    currency: "USD",
    fxRateEur: parseFxRate("0.85005000", "USD"),
  };
  // Chosen so the exact quotient lands on a rounding tie: half-up gives 85.01,
  // any rounding-down mode would silently give 85.00 instead.
  const usdPrices: PriceLookup = {
    priceOn: (_id, date) => (date >= "2025-01-01" ? parseMoney("100,00", "USD") : null),
    priceDateOn: (_id, date) => (date >= "2025-01-01" ? "2025-01-01" : null),
    fxOn: () => parseFxRate("0.85005000", "USD"),
  };
  const series = valueSeries([usdTxn], [usdInstrument], usdPrices, "2025-01-01", "2025-01-01");
  expect(series.map((p) => formatMoney(p.valueEur))).toEqual(["85.01"]);
});

test("an instrument with no known price contributes nothing and marks the day stale", () => {
  const txns = [txn("BUY", "2025-01-01", { qty: "10", amount: "-1000,00" })];
  const neverPriced: PriceLookup = {
    priceOn: () => null,
    priceDateOn: () => null,
    fxOn: () => parseFxRate("1", "EUR"),
  };
  const series = valueSeries(txns, [instrument], neverPriced, "2025-01-01", "2025-01-01");
  expect(series.map((p) => formatMoney(p.valueEur))).toEqual(["0.00"]);
  expect(series.map((p) => p.stale)).toEqual([true]);
});

test("xirr recovers a known 10% annual return", () => {
  const flows: CashFlow[] = [{ date: "2024-01-01", amountEur: parseMoney("-1000,00", "EUR") }];
  const final: CashFlow = { date: "2025-01-01", amountEur: parseMoney("1100,00", "EUR") };
  expect(xirr(flows, final)).toBeCloseTo(0.1, 4);
});

test("xirr handles multiple irregular contributions", () => {
  const flows: CashFlow[] = [
    { date: "2024-01-01", amountEur: parseMoney("-1000,00", "EUR") },
    { date: "2024-07-01", amountEur: parseMoney("-500,00", "EUR") },
  ];
  const final: CashFlow = { date: "2025-01-01", amountEur: parseMoney("1650,00", "EUR") };
  const rate = xirr(flows, final);
  expect(rate).toBeGreaterThan(0.09);
  expect(rate).toBeLessThan(0.13);
});

test("xirr converges on a loss", () => {
  const flows: CashFlow[] = [{ date: "2024-01-01", amountEur: parseMoney("-1000,00", "EUR") }];
  const final: CashFlow = { date: "2025-01-01", amountEur: parseMoney("800,00", "EUR") };
  expect(xirr(flows, final)).toBeCloseTo(-0.2, 4);
});

test("xirr throws rather than returning a bogus rate when all cash flows share a sign", () => {
  const flows: CashFlow[] = [{ date: "2024-01-01", amountEur: parseMoney("-1000,00", "EUR") }];
  const final: CashFlow = { date: "2025-01-01", amountEur: parseMoney("-50,00", "EUR") };
  expect(() => xirr(flows, final)).toThrow(/sign/i);
});

test("xirr falls back to bisection when Newton-Raphson fails to converge", () => {
  // A ~90% loss over a long (~4.1 year) window has an NPV curve so steep near the
  // rate=0.1 seed that Newton's very first tangent-line step overshoots past
  // rate = -1 (outside the domain of (1+rate)^t), so it must fall back to
  // bisection to find the true rate.
  const flows: CashFlow[] = [{ date: "2024-01-01", amountEur: parseMoney("-1000,00", "EUR") }];
  const final: CashFlow = { date: "2028-02-09", amountEur: parseMoney("100,00", "EUR") };
  expect(xirr(flows, final)).toBeCloseTo(-0.4292, 3);
});

test("twr ignores the timing of deposits", () => {
  // Portfolio doubles, but a deposit lands halfway. TWR must stay ~100%, not be diluted.
  const values = [
    { date: "2024-01-01", valueEur: parseMoney("1000,00", "EUR"), stale: false },
    { date: "2024-07-01", valueEur: parseMoney("1400,00", "EUR"), stale: false },
    { date: "2024-12-31", valueEur: parseMoney("3360,00", "EUR"), stale: false },
  ];
  const flows: CashFlow[] = [{ date: "2024-07-01", amountEur: parseMoney("1000,00", "EUR") }];
  expect(twr(values, flows)).toBeCloseTo(0.96, 2);
});

test("twr of a flat portfolio is zero", () => {
  const values = [
    { date: "2024-01-01", valueEur: parseMoney("1000,00", "EUR"), stale: false },
    { date: "2024-12-31", valueEur: parseMoney("1000,00", "EUR"), stale: false },
  ];
  expect(twr(values, [])).toBeCloseTo(0, 6);
});

import { test, expect } from "bun:test";
import { allocateBy } from "./allocation";
import type { PriceLookup } from "./returns";
import type { Instrument, Txn } from "./types";
import { parseMoney, parseQuantity, parseFxRate, parseCurrency, formatMoney, EUR } from "./money";

const USD = parseCurrency("USD");

const instruments: Instrument[] = [
  {
    id: 1,
    isin: "FI0009000681",
    ticker: "NOKIA.HE",
    name: "Nokia",
    kind: "stock",
    currency: EUR,
    priceSource: "yahoo",
    sourceKey: "NOKIA.HE",
  },
  {
    id: 2,
    isin: "IE00B4L5Y983",
    ticker: "IWDA.AS",
    name: "iShares Core MSCI World",
    kind: "etf",
    currency: EUR,
    priceSource: "yahoo",
    sourceKey: "IWDA.AS",
  },
  {
    id: 3,
    isin: "FI0008803812",
    ticker: null,
    name: "OP-Suomi A",
    kind: "fund",
    currency: EUR,
    priceSource: "op_fund",
    sourceKey: "op-suomi-a",
  },
];

const usdInstrument: Instrument = {
  id: 4,
  isin: "US0000000004",
  ticker: "USDCO",
  name: "USD Co",
  kind: "stock",
  currency: USD,
  priceSource: "yahoo",
  sourceKey: "USDCO",
};

const buy = (id: number, accountId: number, qty: string): Txn => ({
  id,
  accountId,
  instrumentId: id,
  type: "BUY",
  tradeDate: "2025-01-01",
  quantity: parseQuantity(qty),
  unitPrice: null,
  amount: parseMoney("-1,00", EUR),
  fee: parseMoney("0", EUR),
  tax: parseMoney("0", EUR),
  currency: EUR,
  fxRateEur: parseFxRate("1", EUR),
});

const prices: PriceLookup = {
  priceOn: (id) => {
    if (id === 4) return parseMoney("200,00", USD);
    return parseMoney({ 1: "10,00", 2: "100,00", 3: "50,00" }[id]!, EUR);
  },
  priceDateOn: () => "2025-06-01",
  fxOn: (currency) => parseFxRate("1", currency),
};

test("groups by instrument kind, largest first", () => {
  const slices = allocateBy(
    [buy(1, 1, "100"), buy(2, 1, "10"), buy(3, 2, "10")],
    instruments,
    prices,
    "2025-06-01",
    "kind",
  );
  expect(slices.map((s) => s.key)).toEqual(["etf", "stock", "fund"]);
  expect(slices.map((s) => formatMoney(s.valueEur))).toEqual(["1000.00", "1000.00", "500.00"]);
});

test("weights sum to one", () => {
  const slices = allocateBy(
    [buy(1, 1, "100"), buy(3, 2, "10")],
    instruments,
    prices,
    "2025-06-01",
    "kind",
  );
  expect(slices.reduce((s, x) => s + x.weight, 0)).toBeCloseTo(1, 9);
});

test("groups by account", () => {
  const slices = allocateBy(
    [buy(1, 1, "100"), buy(3, 2, "10")],
    instruments,
    prices,
    "2025-06-01",
    "account",
  );
  expect(slices.map((s) => s.key)).toEqual(["1", "2"]);
});

test("an empty portfolio has no slices", () => {
  expect(allocateBy([], instruments, prices, "2025-06-01", "kind")).toEqual([]);
});

test("groups by currency", () => {
  const slices = allocateBy(
    [buy(1, 1, "100"), buy(4, 1, "10")],
    [...instruments, usdInstrument],
    prices,
    "2025-06-01",
    "currency",
  );
  expect(slices.map((s) => s.key)).toEqual(["USD", "EUR"]);
  expect(slices.map((s) => formatMoney(s.valueEur))).toEqual(["2000.00", "1000.00"]);
});

test("groups by instrument, using the instrument's name as the label", () => {
  const slices = allocateBy(
    [buy(1, 1, "100"), buy(2, 1, "10")],
    instruments,
    prices,
    "2025-06-01",
    "instrument",
  );
  expect(slices.map((s) => s.key)).toEqual(["1", "2"]);
  expect(slices.map((s) => s.label)).toEqual(["Nokia", "iShares Core MSCI World"]);
});

test("a held instrument with no price on the date is excluded from the totals", () => {
  const noPriceForNokia: PriceLookup = {
    priceOn: (id) => (id === 1 ? null : prices.priceOn(id, "2025-06-01")),
    priceDateOn: () => "2025-06-01",
    fxOn: () => parseFxRate("1", EUR),
  };
  const slices = allocateBy(
    [buy(1, 1, "100"), buy(2, 1, "10")],
    instruments,
    noPriceForNokia,
    "2025-06-01",
    "kind",
  );
  expect(slices.map((s) => s.key)).toEqual(["etf"]);
  expect(slices.map((s) => formatMoney(s.valueEur))).toEqual(["1000.00"]);
});

test("a held instrument priced in a currency with no fx rate is excluded from the totals", () => {
  const noUsdRate: PriceLookup = {
    priceOn: (id) => (id === 4 ? parseMoney("20,00", USD) : prices.priceOn(id, "2025-06-01")),
    priceDateOn: () => "2025-06-01",
    fxOn: () => null,
  };
  const slices = allocateBy(
    [buy(1, 1, "100"), buy(4, 1, "10")],
    [...instruments, usdInstrument],
    noUsdRate,
    "2025-06-01",
    "kind",
  );
  expect(slices.map((s) => s.key)).toEqual(["stock"]);
  expect(slices.map((s) => formatMoney(s.valueEur))).toEqual(["1000.00"]);
});

test("a position in an instrument absent from the instruments list is excluded from the totals", () => {
  const slices = allocateBy(
    [buy(1, 1, "100"), buy(3, 2, "10")],
    instruments.filter((i) => i.id !== 3),
    prices,
    "2025-06-01",
    "kind",
  );
  expect(slices.map((s) => s.key)).toEqual(["stock"]);
});

test("the same instrument held across two accounts aggregates into a single slice", () => {
  const slices = allocateBy(
    [buy(1, 1, "60"), buy(1, 2, "40")],
    instruments,
    prices,
    "2025-06-01",
    "kind",
  );
  expect(slices.map((s) => s.key)).toEqual(["stock"]);
  // 60 + 40 units at 10.00 = 1000.00, matching a single whole-portfolio positionsAt call.
  expect(slices.map((s) => formatMoney(s.valueEur))).toEqual(["1000.00"]);
});

test("the same instrument held across two accounts still produces two account slices", () => {
  const slices = allocateBy(
    [buy(1, 1, "60"), buy(1, 2, "40")],
    instruments,
    prices,
    "2025-06-01",
    "account",
  );
  expect(slices.map((s) => s.key)).toEqual(["1", "2"]);
  expect(slices.map((s) => formatMoney(s.valueEur))).toEqual(["600.00", "400.00"]);
});

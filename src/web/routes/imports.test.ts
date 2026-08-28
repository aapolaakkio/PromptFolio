import { test, expect } from "bun:test";
import { minorToEur, summarise, type DraftResponse } from "./imports-draft";

// Test rows carry only the fields `summarise` reads; a typed factory keeps the
// assertion out of the tests (anti-slop/require-safety-comment-for-type-assertion).
const txnStub = (line: number): DraftResponse["txns"][number] => ({
  line,
  type: "BUY",
  tradeDate: "2025-01-10",
  isin: null,
  quantity: 0,
  amount: 0,
  currency: "EUR",
});

const draft = (over: Partial<DraftResponse> = {}): DraftResponse => ({
  broker: "nordnet",
  filename: "x.csv",
  sha256: "abc",
  txns: [],
  problems: [],
  unknownIsins: [],
  ...over,
});

test("counts rows, problems and unknown instruments", () => {
  const summary = summarise(
    draft({
      txns: [txnStub(2), txnStub(3)],
      problems: [{ line: 4, message: "x", raw: {} }],
      unknownIsins: [{ isin: "IE00B4L5Y983", name: "IWDA", currency: "EUR" }],
    }),
  );
  expect(summary).toMatchObject({ good: 2, problems: 1, unknown: 1 });
});

test("cannot commit while an isin is unresolved", () => {
  expect(
    summarise(
      draft({
        txns: [txnStub(2)],
        unknownIsins: [{ isin: "IE00B4L5Y983", name: "IWDA", currency: "EUR" }],
      }),
    ).canCommit,
  ).toBe(false);
});

test("can commit with problems present but no unknown isins", () => {
  expect(
    summarise(
      draft({
        txns: [txnStub(2)],
        problems: [{ line: 4, message: "x", raw: {} }],
      }),
    ).canCommit,
  ).toBe(true);
});

test("cannot commit an empty draft", () => {
  expect(summarise(draft()).canCommit).toBe(false);
});

// --- OP-specific shapes: null isin (name-only resolution) and a structural rawLine problem ---

test("counts an OP-style unknown instrument (null isin, resolved by name)", () => {
  const summary = summarise(
    draft({
      txns: [txnStub(2)],
      unknownIsins: [{ isin: null, name: "OP-MAAILMA INDEKSI A", currency: "EUR" }],
    }),
  );
  expect(summary).toMatchObject({ good: 1, unknown: 1 });
  expect(summary.canCommit).toBe(false);
});

test("a structural problem (rawLine set, raw empty) still counts as a problem, not a good row", () => {
  const summary = summarise(
    draft({
      txns: [txnStub(2)],
      problems: [{ line: 5, message: "OP-rivilohkosta puuttuu määrä", raw: {}, rawLine: "kaksi" }],
    }),
  );
  expect(summary).toMatchObject({ good: 1, problems: 1, unknown: 0 });
  expect(summary.canCommit).toBe(true);
});

// --- minorToEur: txns[].amount arrives as an integer minor unit, never a decimal string ---

test("minorToEur renders integer minor units as a two-decimal string", () => {
  expect(minorToEur(41800)).toBe("418.00");
  expect(minorToEur(2)).toBe("0.02");
});

test("minorToEur keeps the sign for a negative (outflow) amount", () => {
  expect(minorToEur(-30002)).toBe("-300.02");
});

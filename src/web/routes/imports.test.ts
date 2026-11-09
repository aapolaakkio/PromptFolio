import { test, expect } from "vitest";
import { z } from "zod";
import {
  minorToEur,
  summarise,
  summariseAll,
  unknownAcross,
  type DraftResponse,
} from "./imports-draft.ts";

// Test rows carry only the fields `summarise` reads; a typed factory keeps the
// assertion out of the tests (anti-slop/require-safety-comment-for-type-assertion).
const txnStub = (line: number): DraftResponse["txns"][number] => ({
  line,
  accountId: 1,
  instrumentId: null,
  isin: null,
  type: "BUY",
  tradeDate: "2025-01-10",
  quantity: 0,
  unitPrice: null,
  amount: 0,
  fee: 0,
  tax: 0,
  currency: "EUR",
  fxRateEur: 100_000_000,
  externalId: null,
  note: null,
});

const draft = (over: Partial<DraftResponse> = {}): DraftResponse => ({
  broker: "nordnet",
  filename: "x.csv",
  sha256: "abc",
  txns: [],
  problems: [],
  unknownIsins: [],
  added: [],
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

// A holding no registry carries has no ISIN at all (a delisted share, or the
// temporary line a corporate action creates). The dashboard's own schemas
// rejected that, which failed the whole page with a generic "could not load"
// and made TanStack Query retry -- two /api/returns calls for one render.
test("the dashboard's excluded-instrument shape accepts a holding with no ISIN", () => {
  const schema = z.array(
    z.object({ instrumentId: z.number(), isin: z.string().nullable(), name: z.string() }),
  );
  expect(schema.parse([{ instrumentId: 27, isin: null, name: "ESIMERKKI OYJ/SH NV" }])).toEqual([
    { instrumentId: 27, isin: null, name: "ESIMERKKI OYJ/SH NV" },
  ]);
});

test("summariseAll adds up every file and commits only when each file can", () => {
  const ok = draft({ txns: [txnStub(2), txnStub(3)] });
  const unknown = draft({
    txns: [txnStub(4)],
    unknownIsins: [{ isin: "FI0009000681", name: "NOKIA", currency: "EUR" }],
  });
  expect(summariseAll([ok, ok])).toEqual({ good: 4, problems: 0, unknown: 0, canCommit: true });
  expect(summariseAll([ok, unknown]).canCommit).toBe(false);
  expect(summariseAll([ok, unknown]).unknown).toBe(1);
  // A file with nothing to import would only leave an empty import record.
  expect(summariseAll([ok, draft()]).canCommit).toBe(false);
  expect(summariseAll([]).canCommit).toBe(false);
});

test("unknownAcross lists an instrument once however many files name it", () => {
  const nokia = { isin: "FI0009000681", name: "NOKIA", currency: "EUR" };
  const byName = { isin: null, name: "OP-Maailma", currency: "EUR" };
  const drafts = [
    draft({ unknownIsins: [nokia, byName] }),
    draft({ unknownIsins: [nokia, { ...byName, currency: "SEK" }] }),
  ];
  expect(unknownAcross(drafts)).toEqual([nokia, byName]);
});

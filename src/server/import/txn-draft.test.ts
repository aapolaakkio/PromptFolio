import { describe, expect, test } from "vitest";

import { DraftBody, transactionsDraftFrom } from "./txn-draft.ts";

const row = {
  date: "2025-01-10",
  type: "BUY" as const,
  name: "Nokia",
  isin: "FI0009000681",
  quantity: "100",
  unitPrice: "4,15",
  amount: "-418,00",
  fee: "3.00",
  tax: "0",
  currency: "EUR",
};

describe("transactionsDraftFrom", () => {
  test("maps a reading into draft rows in minor units, resolving the instrument by ISIN", () => {
    const draft = transactionsDraftFrom(
      { transactions: [row], problems: [] },
      { accountId: 7, knownIsins: new Map([["FI0009000681", 3]]), knownNames: new Map() },
    );
    expect(draft.txns[0]).toMatchObject({
      line: 1,
      accountId: 7,
      instrumentId: 3,
      isin: "FI0009000681",
      type: "BUY",
      tradeDate: "2025-01-10",
      quantity: 100_000_000,
      unitPrice: 415,
      amount: -41_800,
      fee: 300,
      tax: 0,
      currency: "EUR",
      fxRateEur: 100_000_000,
      externalId: null,
      note: "Nokia",
    });
    expect(draft.unknownIsins).toEqual([]);
  });

  test("a name-only row resolves by name, and an unknown one is listed, never invented", () => {
    const draft = transactionsDraftFrom(
      {
        transactions: [
          { ...row, isin: null, name: "OP-Maailma" },
          { ...row, isin: null, name: "Uusi rahasto" },
        ],
        problems: [],
      },
      { accountId: 7, knownIsins: new Map(), knownNames: new Map([["OP-MAAILMA", 5]]) },
    );
    expect(draft.txns.map((t) => t.instrumentId)).toEqual([5, null]);
    expect(draft.unknownIsins).toEqual([{ isin: null, name: "Uusi rahasto", currency: "EUR" }]);
  });

  test("a row the figures refuse becomes a problem carrying its text", () => {
    const draft = transactionsDraftFrom(
      { transactions: [{ ...row, amount: "paljon" }], problems: [{ line: 4, text: "rivi 4" }] },
      { accountId: 7, knownIsins: new Map(), knownNames: new Map() },
    );
    expect(draft.txns).toEqual([]);
    expect(draft.problems.map((p) => p.line)).toEqual([1, 4]);
    expect(draft.problems[1]).toMatchObject({ rawLine: "rivi 4" });
  });

  test("a non-EUR row is left for the commit to price", () => {
    const draft = transactionsDraftFrom(
      { transactions: [{ ...row, currency: "SEK" }], problems: [] },
      { accountId: 7, knownIsins: new Map(), knownNames: new Map() },
    );
    expect(draft.txns[0]?.fxRateEur).toBe(0);
  });
});

describe("DraftBody", () => {
  test("accepts exactly a Draft and nothing more", () => {
    const draft = transactionsDraftFrom(
      { transactions: [row], problems: [] },
      { accountId: 7, knownIsins: new Map(), knownNames: new Map() },
    );
    expect(DraftBody.parse(draft)).toEqual(draft);
    expect(DraftBody.safeParse({ ...draft, extra: 1 }).success).toBe(false);
    expect(
      DraftBody.safeParse({ ...draft, txns: [{ ...draft.txns[0], amount: "1" }] }).success,
    ).toBe(false);
  });

  test("a malformed currency fails validation instead of throwing out of parseCurrency", () => {
    const draft = transactionsDraftFrom(
      { transactions: [row], problems: [] },
      { accountId: 7, knownIsins: new Map(), knownNames: new Map() },
    );
    for (const currency of ["eur", "12X"]) {
      expect(() =>
        DraftBody.safeParse({
          ...draft,
          txns: [{ ...draft.txns[0], currency }],
        }),
      ).not.toThrow();
      expect(
        DraftBody.safeParse({ ...draft, txns: [{ ...draft.txns[0], currency }] }).success,
      ).toBe(false);

      expect(() =>
        DraftBody.safeParse({
          ...draft,
          unknownIsins: [{ isin: null, name: "Uusi rahasto", currency }],
        }),
      ).not.toThrow();
      expect(
        DraftBody.safeParse({
          ...draft,
          unknownIsins: [{ isin: null, name: "Uusi rahasto", currency }],
        }).success,
      ).toBe(false);
    }
  });
});

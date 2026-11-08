import { describe, expect, test } from "vitest";

import { DraftBody } from "./txn-draft.ts";

/** A draft as `mapRows` builds one: one buy, nothing unresolved. */
const draft = {
  txns: [
    {
      line: 2,
      accountId: 7,
      instrumentId: null,
      isin: "FI0009000681",
      type: "BUY",
      tradeDate: "2025-01-10",
      quantity: 100_000_000,
      unitPrice: 415,
      amount: -41800,
      fee: 300,
      tax: 0,
      currency: "EUR",
      fxRateEur: 100_000_000,
      externalId: null,
      note: null,
    },
  ],
  problems: [],
  unknownIsins: [],
};

describe("DraftBody", () => {
  test("accepts exactly a Draft and nothing more", () => {
    expect(DraftBody.parse(draft)).toEqual(draft);
    expect(DraftBody.safeParse({ ...draft, extra: 1 }).success).toBe(false);
    expect(
      DraftBody.safeParse({ ...draft, txns: [{ ...draft.txns[0], amount: "1" }] }).success,
    ).toBe(false);
  });

  test("a malformed currency fails validation instead of throwing out of parseCurrency", () => {
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

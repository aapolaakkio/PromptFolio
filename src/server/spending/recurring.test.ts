import { describe, expect, test } from "bun:test";

import { EUR, parseMoney } from "../../core/money";
import type { IsoDate, Txn } from "../../core/types";
import { SEED_RULES } from "./categories";
import { recurringPayments } from "./recurring";
import type { SpendingRule } from "./rules";

// The question this answers is "what am I committed to every month", and the
// two ways it lies are opposite: reporting the weekly shop as a subscription,
// and missing a bill because one month's payment landed a few days late.

const RULES: SpendingRule[] = SEED_RULES.map((rule) => ({ ...rule, source: "seed" }));

let nextId = 1;
const row = (note: string, amount: string, tradeDate: IsoDate): Txn => ({
  id: nextId++,
  accountId: 1,
  instrumentId: null,
  type: "WITHDRAWAL",
  tradeDate,
  quantity: { scaled: 0n },
  unitPrice: null,
  amount: parseMoney(amount, EUR),
  fee: parseMoney("0", EUR),
  tax: parseMoney("0", EUR),
  currency: EUR,
  fxRateEur: { scaled: 100_000_000n, currency: EUR },
  note,
});

const found = (txns: readonly Txn[], to: IsoDate = "2026-06-30") =>
  recurringPayments({
    txns,
    rules: RULES,
    bankAccountIds: new Set([1]),
    excludedIds: new Set(),
    from: "2020-01-01",
    to,
  });

describe("recurringPayments", () => {
  test("finds a monthly bill and states what it costs in a year", () => {
    const payments = found([
      row("TILISIIRTO — SUORATOISTO OY", "-12.99", "2026-04-05"),
      row("TILISIIRTO — SUORATOISTO OY", "-12.99", "2026-05-05"),
      row("TILISIIRTO — SUORATOISTO OY", "-12.99", "2026-06-05"),
    ]);

    expect(payments).toHaveLength(1);
    expect(payments[0]?.cadence).toBe("monthly");
    expect(payments[0]?.typicalEur).toBe("12.99");
    // The figure a person actually weighs a subscription against.
    expect(payments[0]?.annualEur).toBe("155.88");
    expect(payments[0]?.active).toBe(true);
  });

  test("does not call the weekly shop a subscription", () => {
    // Same payee, a regular rhythm -- and a different amount every time, which
    // is the whole difference between a shop and a standing cost.
    const payments = found([
      row("PKORTTIMAKSU — K-MARKET ESIMERKKI", "-42.15", "2026-06-01"),
      row("PKORTTIMAKSU — K-MARKET ESIMERKKI", "-18.90", "2026-06-08"),
      row("PKORTTIMAKSU — K-MARKET ESIMERKKI", "-63.40", "2026-06-15"),
      row("PKORTTIMAKSU — K-MARKET ESIMERKKI", "-31.05", "2026-06-22"),
    ]);

    expect(payments).toEqual([]);
  });

  test("tolerates a payment that lands a few days late", () => {
    // A bill paid on the 3rd, the 6th and the 2nd is one bill, not three
    // unrelated payments: the gaps are 34 and 27 days.
    const payments = found([
      row("TILISIIRTO — VAKUUTUS OY", "-30.00", "2026-04-03"),
      row("TILISIIRTO — VAKUUTUS OY", "-30.00", "2026-05-07"),
      row("TILISIIRTO — VAKUUTUS OY", "-30.00", "2026-06-03"),
    ]);

    expect(payments).toHaveLength(1);
    expect(payments[0]?.cadence).toBe("monthly");
  });

  test("marks a cancelled service inactive rather than dropping it", () => {
    const payments = found(
      [
        row("TILISIIRTO — VANHA PALVELU", "-9.90", "2025-01-10"),
        row("TILISIIRTO — VANHA PALVELU", "-9.90", "2025-02-10"),
        row("TILISIIRTO — VANHA PALVELU", "-9.90", "2025-03-10"),
      ],
      "2026-06-30",
    );

    // Still reported, because "you used to pay this" is an answer; silently
    // omitting it would read as never having been paid at all.
    expect(payments[0]?.active).toBe(false);
    expect(payments[0]?.lastDate).toBe("2025-03-10");
  });

  test("needs three payments before calling anything a rhythm", () => {
    const payments = found([
      row("TILISIIRTO — KAHDESTI OY", "-5.00", "2026-05-01"),
      row("TILISIIRTO — KAHDESTI OY", "-5.00", "2026-06-01"),
    ]);

    expect(payments).toEqual([]);
  });

  test("leaves out what is not spending at all", () => {
    const rows = [
      row("TILISIIRTO — OMA SÄÄSTÖ", "-100.00", "2026-04-01"),
      row("TILISIIRTO — OMA SÄÄSTÖ", "-100.00", "2026-05-01"),
      row("TILISIIRTO — OMA SÄÄSTÖ", "-100.00", "2026-06-01"),
    ];
    // A standing transfer to one's own savings is regular and identical every
    // month, and it is not a cost -- the caller's exclusions decide that.
    const payments = recurringPayments({
      txns: rows,
      rules: RULES,
      bankAccountIds: new Set([1]),
      excludedIds: new Set(rows.map((txn) => txn.id)),
      from: "2020-01-01",
      to: "2026-06-30",
    });

    expect(payments).toEqual([]);
  });
});

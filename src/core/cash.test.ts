import { describe, expect, test } from "bun:test";

import { cashBalancesAt, totalCashEur, valueCash } from "./cash";
import { EUR, formatMoney, parseCurrency, parseMoney, type Currency } from "./money";
import type { IsoDate, TransactionType, Txn } from "./types";

const SEK = parseCurrency("SEK");

let nextId = 1;
const txn = (
  type: TransactionType,
  accountId: number,
  amount: string,
  currency: Currency = EUR,
  tradeDate: IsoDate = "2026-01-10",
): Txn => ({
  id: nextId++,
  accountId,
  instrumentId: null,
  type,
  tradeDate,
  quantity: { scaled: 0n },
  unitPrice: null,
  amount: parseMoney(amount, currency),
  fee: parseMoney("0", currency),
  tax: parseMoney("0", currency),
  currency,
  fxRateEur: { scaled: 100_000_000n, currency },
});

describe("cashBalancesAt", () => {
  test("nets every row that moved cash, per account and currency", () => {
    const balances = cashBalancesAt(
      [
        txn("DEPOSIT", 1, "1000.00"),
        txn("BUY", 1, "-400.00"),
        txn("DIVIDEND", 1, "12.50"),
        txn("DEPOSIT", 2, "250.00"),
      ],
      "2026-06-01",
    );

    expect(balances).toHaveLength(2);
    expect(formatMoney(balances[0]!.amount)).toBe("612.50");
    expect(balances[0]!.accountId).toBe(1);
    expect(formatMoney(balances[1]!.amount)).toBe("250.00");
  });

  test("keeps one account's currencies apart rather than adding kronor to euros", () => {
    const balances = cashBalancesAt(
      [txn("DEPOSIT", 1, "1000.00"), txn("DEPOSIT", 1, "5000.00", SEK)],
      "2026-06-01",
    );

    expect(balances.map((b) => b.currency)).toEqual([EUR, SEK]);
    expect(balances.map((b) => formatMoney(b.amount))).toEqual(["1000.00", "5000.00"]);
  });

  test("counts only what had happened by the asked date", () => {
    const txns = [
      txn("DEPOSIT", 1, "1000.00", EUR, "2026-01-10"),
      txn("DEPOSIT", 1, "500.00", EUR, "2026-07-01"),
    ];

    expect(formatMoney(cashBalancesAt(txns, "2026-06-01")[0]!.amount)).toBe("1000.00");
    expect(formatMoney(cashBalancesAt(txns, "2026-12-31")[0]!.amount)).toBe("1500.00");
  });

  test("drops a spent-out balance but keeps a negative one, which is real", () => {
    const spent = cashBalancesAt(
      [txn("DEPOSIT", 1, "100.00"), txn("BUY", 1, "-100.00")],
      "2026-06-01",
    );
    expect(spent).toEqual([]);

    // The account records cash (there is a deposit), so an overdraft is a fact
    // about the account rather than a gap in the export.
    const overdrawn = cashBalancesAt(
      [txn("DEPOSIT", 1, "100.00"), txn("BUY", 1, "-250.00")],
      "2026-06-01",
    );
    expect(formatMoney(overdrawn[0]!.amount)).toBe("-150.00");
  });

  test("ignores an account whose export records no cash at all", () => {
    // OP's transaction view: purchases with no deposit behind them. Summing its
    // rows would report the negative of everything ever bought as a balance.
    const opOnly = cashBalancesAt(
      [txn("BUY", 7, "-1000.00"), txn("BUY", 7, "-500.00")],
      "2026-06-01",
    );
    expect(opOnly).toEqual([]);

    // ...while an account that does record cash is unaffected by its neighbour.
    const mixed = cashBalancesAt(
      [txn("BUY", 7, "-1000.00"), txn("DEPOSIT", 1, "300.00")],
      "2026-06-01",
    );
    expect(mixed.map((b) => b.accountId)).toEqual([1]);
  });
});

describe("valueCash", () => {
  const fxOn = (currency: Currency) =>
    currency === SEK ? { scaled: 8_700_000n, currency: SEK } : null;

  test("passes euros through and converts everything else at the day's rate", () => {
    const valued = valueCash(
      cashBalancesAt(
        [txn("DEPOSIT", 1, "1000.00"), txn("DEPOSIT", 1, "5000.00", SEK)],
        "2026-06-01",
      ),
      fxOn,
      "2026-06-01",
    );

    expect(formatMoney(valued[0]!.valueEur!)).toBe("1000.00");
    // 5000 SEK at 0,087 EUR/SEK.
    expect(formatMoney(valued[1]!.valueEur!)).toBe("435.00");
  });

  test("reports an unconvertible balance as null instead of dropping or zeroing it", () => {
    const nok = parseCurrency("NOK");
    const valued = valueCash(
      cashBalancesAt([txn("DEPOSIT", 1, "700.00", nok)], "2026-06-01"),
      fxOn,
      "2026-06-01",
    );

    expect(valued[0]!.valueEur).toBeNull();
    expect(formatMoney(valued[0]!.amount)).toBe("700.00");
  });
});

describe("totalCashEur", () => {
  test("adds what could be valued and silently skips nothing else", () => {
    const valued = valueCash(
      cashBalancesAt(
        [txn("DEPOSIT", 1, "1000.00"), txn("DEPOSIT", 2, "5000.00", SEK)],
        "2026-06-01",
      ),
      (currency) => (currency === SEK ? { scaled: 8_700_000n, currency: SEK } : null),
      "2026-06-01",
    );

    expect(formatMoney(totalCashEur(valued))).toBe("1435.00");
  });

  test("is zero euros when there is no cash at all", () => {
    expect(formatMoney(totalCashEur([]))).toBe("0.00");
  });
});

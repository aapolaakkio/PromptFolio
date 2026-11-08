import { describe, expect, test } from "vitest";

import {
  availableCashEur,
  cashBalancesAt,
  cashSeries,
  lockedCashEur,
  totalCashEur,
  valueCash,
} from "./cash.ts";
import { EUR, formatMoney, parseCurrency, parseMoney, type Currency } from "./money.ts";
import type { IsoDate, TransactionType, Txn } from "./types.ts";

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

  test("ignores a transfer's amount, which is carried cost basis rather than cash", () => {
    // A real tender offer: the shares arrive with the acquisition value the
    // broker stated, so the original cost rides across to the new instrument.
    // No money moved, and counting it charged a real account 42,60 EUR.
    const balances = cashBalancesAt(
      [
        txn("DEPOSIT", 1, "1000.00"),
        txn("TRANSFER_IN", 1, "-42.60"),
        txn("TRANSFER_OUT", 1, "0.00"),
      ],
      "2026-06-01",
    );

    expect(formatMoney(balances[0]!.amount)).toBe("1000.00");
  });

  test("ignores a split, which moves units and no money", () => {
    const balances = cashBalancesAt(
      [txn("DEPOSIT", 1, "1000.00"), txn("SPLIT", 1, "0.00")],
      "2026-06-01",
    );
    expect(formatMoney(balances[0]!.amount)).toBe("1000.00");
  });

  test("counts every type that does move money", () => {
    const balances = cashBalancesAt(
      [
        txn("DEPOSIT", 1, "1000.00"),
        txn("BUY", 1, "-400.00"),
        txn("SELL", 1, "150.00"),
        txn("DIVIDEND", 1, "12.00"),
        txn("INTEREST", 1, "1.50"),
        txn("FEE", 1, "-3.50"),
        txn("WITHDRAWAL", 1, "-100.00"),
      ],
      "2026-06-01",
    );
    expect(formatMoney(balances[0]!.amount)).toBe("660.00");
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

describe("available and locked cash", () => {
  const valued = () => [
    {
      accountId: 1,
      currency: EUR,
      amount: parseMoney("500.00", EUR),
      valueEur: parseMoney("500.00", EUR),
      locked: false,
    },
    {
      accountId: 2,
      currency: EUR,
      amount: parseMoney("10000.00", EUR),
      valueEur: parseMoney("10000.00", EUR),
      locked: true,
      availableFrom: "2027-06-22",
    },
  ];

  test("counts a fixed-term deposit toward the total but not toward what is spendable", () => {
    expect(formatMoney(totalCashEur(valued()))).toBe("10500.00");
    expect(formatMoney(availableCashEur(valued()))).toBe("500.00");
    expect(formatMoney(lockedCashEur(valued()))).toBe("10000.00");
  });

  test("treats a balance with no availability stated as spendable", () => {
    // Every account but a deposit is reachable, so the flag is optional and its
    // absence must not quietly lock money away.
    const plain = [
      {
        accountId: 1,
        currency: EUR,
        amount: parseMoney("500.00", EUR),
        valueEur: parseMoney("500.00", EUR),
      },
    ];
    expect(formatMoney(availableCashEur(plain))).toBe("500.00");
    expect(formatMoney(lockedCashEur(plain))).toBe("0.00");
  });

  test("leaves an unvaluable balance out of both, rather than guessing", () => {
    const unpriced = [
      { accountId: 1, currency: EUR, amount: parseMoney("500.00", EUR), valueEur: null },
    ];
    expect(formatMoney(availableCashEur(unpriced))).toBe("0.00");
    expect(formatMoney(lockedCashEur(unpriced))).toBe("0.00");
  });
});

describe("cashSeries", () => {
  const noFx = () => null;

  test("gives each day the balance cashBalancesAt would, in one pass", () => {
    const txns = [
      txn("DEPOSIT", 1, "1000.00", EUR, "2026-01-01"),
      txn("WITHDRAWAL", 1, "-300.00", EUR, "2026-01-03"),
      txn("INTEREST", 1, "1.50", EUR, "2026-01-03"),
    ];
    const series = cashSeries(txns, noFx, "2026-01-01", "2026-01-04");

    expect(series.map((p) => [p.date, formatMoney(p.cashEur)])).toEqual([
      ["2026-01-01", "1000.00"],
      ["2026-01-02", "1000.00"],
      ["2026-01-03", "701.50"],
      ["2026-01-04", "701.50"],
    ]);
    for (const point of series) {
      expect(
        formatMoney(totalCashEur(valueCash(cashBalancesAt(txns, point.date), noFx, point.date))),
      ).toBe(formatMoney(point.cashEur));
    }
  });

  test("leaves a currency with no rate that day out of the total, never as euros", () => {
    const series = cashSeries(
      [txn("DEPOSIT", 1, "100.00"), txn("DEPOSIT", 1, "500.00", SEK)],
      noFx,
      "2026-01-10",
      "2026-01-10",
    );
    expect(formatMoney(series[0]!.cashEur)).toBe("100.00");
  });
});

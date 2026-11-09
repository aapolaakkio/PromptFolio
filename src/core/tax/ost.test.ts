import { describe, expect, test } from "vitest";

import { EUR, formatMoney, parseFxRate, parseMoney, parseQuantity } from "../money.ts";
import type { IsoDate, TransactionType, Txn } from "../types.ts";
import { ostReport, reservationPairIds, type OstValuation } from "./ost.ts";

let nextId = 1;
const row = (
  type: TransactionType,
  tradeDate: IsoDate,
  amount: string,
  note: string | null = null,
): Txn => ({
  id: nextId++,
  accountId: 7,
  instrumentId: null,
  type,
  tradeDate,
  quantity: parseQuantity("0"),
  unitPrice: null,
  amount: parseMoney(amount, EUR),
  fee: parseMoney("0", EUR),
  tax: parseMoney("0", EUR),
  currency: EUR,
  fxRateEur: parseFxRate("1", EUR),
  note,
});

const deposit = (on: IsoDate, amount: string, note: string | null = null) =>
  row("DEPOSIT", on, amount, note);
const withdrawal = (on: IsoDate, amount: string, note: string | null = null) =>
  row("WITHDRAWAL", on, `-${amount}`, note);
const worth =
  (value: string): (() => OstValuation) =>
  () => ({
    ok: true,
    valueEur: parseMoney(value, EUR),
    pricedFrom: null,
    pricedFromInstrumentId: null,
  });

const YEAR = { from: "2025-01-01", to: "2025-12-31" };

describe("ostReport", () => {
  test("reproduces vero.fi's own worked example", () => {
    // vero.fi example: EUR 15,000 with EUR 5,000 profit, withdrawing EUR 1,500 gives EUR 500 taxable.
    const report = ostReport({
      txns: [deposit("2020-01-02", "10000,00"), withdrawal("2025-06-01", "1500,00")],
      valueAt: worth("15000,00"),
      ...YEAR,
    });

    const outcome = report.withdrawals[0]!.outcome;
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(formatMoney(outcome.profitEur)).toBe("5000.00");
    expect(formatMoney(outcome.taxableEur)).toBe("500.00");
  });

  test("lets the capital part of a withdrawal reduce the deposits", () => {
    // 500 € of the 1 500 € was profit, so 1 000 € capital returned: deposits fall to 9 000 €.
    const report = ostReport({
      txns: [deposit("2020-01-02", "10000,00"), withdrawal("2025-06-01", "1500,00")],
      valueAt: worth("15000,00"),
      ...YEAR,
    });

    expect(formatMoney(report.depositedEur)).toBe("9000.00");
    expect(formatMoney(report.capRemainingEur)).toBe("91000.00");
  });

  test("taxes nothing when the account is worth no more than what was paid in", () => {
    // An OST loss is deductible only on closing, so a loss withdrawal is not taxable, never negative.
    const report = ostReport({
      txns: [deposit("2020-01-02", "10000,00"), withdrawal("2025-06-01", "1000,00")],
      valueAt: worth("8000,00"),
      ...YEAR,
    });

    const outcome = report.withdrawals[0]!.outcome;
    if (!outcome.ok) throw new Error("expected a valued withdrawal");
    expect(formatMoney(outcome.profitEur)).toBe("0.00");
    expect(formatMoney(outcome.taxableEur)).toBe("0.00");
  });

  test("names the instrument when the account cannot be valued, and guesses nothing", () => {
    const report = ostReport({
      txns: [deposit("2020-01-02", "10000,00"), withdrawal("2025-06-01", "1500,00")],
      valueAt: () => ({ ok: false, instrumentId: 42 }),
      ...YEAR,
    });

    const outcome = report.withdrawals[0]!.outcome;
    expect(outcome.ok).toBe(false);
    if (outcome.ok || outcome.reason !== "no-price") throw new Error("expected a no-price block");
    expect(outcome.instrumentId).toBe(42);
    // Split unknown: deposits cannot advance, and the report says the figures are behind.
    expect(formatMoney(report.depositedEur)).toBe("10000.00");
    expect(report.incomplete).toBe(true);
  });

  test("carries earlier years' withdrawals into the state without reporting them", () => {
    // 2024: 500 € profit, so deposits fall to 9 000 € before 2025.
    const report = ostReport({
      txns: [
        deposit("2020-01-02", "10000,00"),
        withdrawal("2024-06-01", "1500,00"),
        withdrawal("2025-06-01", "1500,00"),
      ],
      valueAt: worth("15000,00"),
      ...YEAR,
    });

    expect(report.withdrawals).toHaveLength(1);
    expect(report.withdrawals[0]!.withdrawnOn).toBe("2025-06-01");
    const outcome = report.withdrawals[0]!.outcome;
    if (!outcome.ok) throw new Error("expected a valued withdrawal");
    // Profit is now 6 000, so the taxable share is larger for the same amount.
    expect(formatMoney(outcome.profitEur)).toBe("6000.00");
    expect(formatMoney(outcome.taxableEur)).toBe("600.00");
  });

  test("counts deposits toward the cap and never reports negative room", () => {
    const report = ostReport({
      txns: [deposit("2020-01-02", "100000,00"), deposit("2021-01-02", "5000,00")],
      valueAt: worth("105000,00"),
      ...YEAR,
    });

    expect(formatMoney(report.depositedEur)).toBe("105000.00");
    expect(formatMoney(report.capRemainingEur)).toBe("0.00");
  });
});

test("values the account before the withdrawal, not after it", () => {
  // Valued before the withdrawal; after it the shrunken total inflates the profit share.
  const withdrawn = withdrawal("2025-06-01", "1500,00");
  const seen: number[] = [];
  ostReport({
    txns: [deposit("2020-01-02", "10000,00"), withdrawn],
    valueAt: (_on, beforeTxnId) => {
      seen.push(beforeTxnId);
      return {
        ok: true,
        valueEur: parseMoney("15000,00", EUR),
        pricedFrom: null,
        pricedFromInstrumentId: null,
      };
    },
    ...YEAR,
  });

  expect(seen).toEqual([withdrawn.id]);
});

describe("a share subscription's reservation", () => {
  // A real IPO on an OST: payment in, subscription taken out, allotment bought, reservation returned days later (plain TALLETUS/NOSTO rows).
  const subscription = () => [
    deposit("2026-03-02", "900,00"),
    withdrawal("2026-03-05", "900,00"),
    deposit("2026-03-09", "900,00"),
  ];

  test("is not a withdrawal, because the money never left the owner", () => {
    const report = ostReport({
      txns: subscription(),
      valueAt: worth("900,00"),
      from: "2026-01-01",
      to: "2026-12-31",
    });

    expect(report.withdrawals).toEqual([]);
  });

  test("does not consume the deposits that fund the cap", () => {
    const report = ostReport({
      txns: subscription(),
      valueAt: worth("900,00"),
      from: "2026-01-01",
      to: "2026-12-31",
    });

    // One payment in of 900,00, not reduced by the subscription withdrawal.
    expect(formatMoney(report.depositedEur)).toBe("900.00");
    expect(formatMoney(report.capRemainingEur)).toBe("99100.00");
  });

  test("pairs the refund with the reservation, each row used once", () => {
    const rows = subscription();
    const paired = reservationPairIds(rows);

    expect(paired.has(rows[1]!.id)).toBe(true);
    expect(paired.has(rows[2]!.id)).toBe(true);
    expect(paired.has(rows[0]!.id)).toBe(false);
  });

  test("leaves a genuine withdrawal alone when no equal deposit follows it", () => {
    const report = ostReport({
      txns: [deposit("2020-01-02", "10000,00"), withdrawal("2025-06-01", "1500,00")],
      valueAt: worth("15000,00"),
      ...YEAR,
    });

    expect(report.withdrawals).toHaveLength(1);
  });

  test("does not pair a deposit that came before the withdrawal", () => {
    // Paid in then genuinely taken out: two real events; only a refund that follows its reservation cancels one.
    const report = ostReport({
      txns: [deposit("2025-05-01", "1500,00"), withdrawal("2025-06-01", "1500,00")],
      valueAt: worth("15000,00"),
      ...YEAR,
    });

    expect(report.withdrawals).toHaveLength(1);
  });

  test("does not pair a refund that arrives weeks later", () => {
    const report = ostReport({
      txns: [withdrawal("2025-06-01", "1500,00"), deposit("2025-07-15", "1500,00")],
      valueAt: worth("15000,00"),
      ...YEAR,
    });

    expect(report.withdrawals).toHaveLength(1);
  });
});

describe("tax the broker withheld", () => {
  // The broker books withheld tax as its own row (the capital-income-tax row, mapped to FEE): withdrawn = received + withheld.
  const tax = (on: IsoDate, amount: string) => row("FEE", on, `-${amount}`);

  test("counts toward the amount withdrawn", () => {
    const report = ostReport({
      txns: [
        deposit("2020-01-02", "10000,00"),
        withdrawal("2025-06-01", "1490,00"),
        tax("2025-06-01", "10,00"),
      ],
      valueAt: worth("15000,00"),
      ...YEAR,
    });

    const line = report.withdrawals[0]!;
    // 1 490,00 reached the owner, 10,00 withheld.
    expect(formatMoney(line.amountEur)).toBe("1500.00");
    expect(formatMoney(line.withheldEur)).toBe("10.00");
    const outcome = line.outcome;
    if (!outcome.ok) throw new Error("expected a valued withdrawal");
    expect(formatMoney(outcome.taxableEur)).toBe("500.00");
  });

  test("is split across a day's withdrawals in proportion, so the parts sum to what left", () => {
    // One withdrawal arrives as several rows with one withholding row for the day.
    const report = ostReport({
      txns: [
        deposit("2020-01-02", "10000,00"),
        withdrawal("2025-06-01", "80,00"),
        withdrawal("2025-06-01", "20,00"),
        tax("2025-06-01", "10,00"),
      ],
      valueAt: worth("15000,00"),
      ...YEAR,
    });

    const total = report.withdrawals.reduce((sum, w) => sum + Number(formatMoney(w.amountEur)), 0);
    expect(total.toFixed(2)).toBe("110.00");
    const withheld = report.withdrawals.reduce(
      (sum, w) => sum + Number(formatMoney(w.withheldEur)),
      0,
    );
    expect(withheld.toFixed(2)).toBe("10.00");
  });
});

describe("after a withdrawal that could not be valued", () => {
  test("later withdrawals are reported as unknown, not as zero", () => {
    // An unpriced holding blocked a 2021 withdrawal; later ones must not read as 0,00 € taxable.
    let call = 0;
    const report = ostReport({
      txns: [
        deposit("2020-01-02", "1000,00"),
        withdrawal("2021-06-01", "100,00"),
        withdrawal("2025-06-01", "100,00"),
      ],
      valueAt: () => {
        call += 1;
        return call === 1
          ? { ok: false, instrumentId: 42 }
          : {
              ok: true,
              valueEur: parseMoney("2000,00", EUR),
              pricedFrom: null,
              pricedFromInstrumentId: null,
            };
      },
      from: "2020-01-01",
      to: "2025-12-31",
    });

    const later = report.withdrawals[1]!.outcome;
    expect(later.ok).toBe(false);
    if (later.ok || later.reason !== "earlier-withdrawal")
      throw new Error("expected an earlier-gap block");
    expect(later.since).toBe("2021-06-01");
    expect(report.incomplete).toBe(true);
  });

  test("does not keep asking for a valuation it cannot use", () => {
    let calls = 0;
    ostReport({
      txns: [
        deposit("2020-01-02", "1000,00"),
        withdrawal("2021-06-01", "100,00"),
        withdrawal("2025-06-01", "100,00"),
      ],
      valueAt: () => {
        calls += 1;
        return { ok: false, instrumentId: 42 };
      },
      from: "2020-01-01",
      to: "2025-12-31",
    });

    expect(calls).toBe(1);
  });
});

describe("when the broker says what a row was", () => {
  test("its own words identify a subscription, not the shape of the amounts", () => {
    const report = ostReport({
      txns: [
        deposit("2026-03-02", "900,00"),
        withdrawal("2026-03-05", "900,00", "REAKTOR MERKINTÄSITOUMUS 7,43 EUR/OSAKE"),
        deposit("2026-03-09", "900,00", "REAKTOR MERK.MAKSUN PALAUTUS 7,43 EUR/OSAKE"),
      ],
      valueAt: worth("900,00"),
      from: "2026-01-01",
      to: "2026-12-31",
    });

    expect(report.withdrawals).toEqual([]);
    expect(formatMoney(report.depositedEur)).toBe("900.00");
  });

  test("a withdrawal it named something else stays a withdrawal, however neatly it pairs", () => {
    // An ordinary withdrawal then a same-size deposit is two real events, not a subscription.
    const report = ostReport({
      txns: [
        deposit("2020-01-02", "10000,00"),
        withdrawal("2025-06-01", "1500,00", "Internal to 12345678"),
        deposit("2025-06-04", "1500,00", "Internal from 12345678"),
      ],
      valueAt: worth("15000,00"),
      ...YEAR,
    });

    expect(report.withdrawals).toHaveLength(1);
    const outcome = report.withdrawals[0]!.outcome;
    if (!outcome.ok) throw new Error("expected a valued withdrawal");
    expect(formatMoney(outcome.taxableEur)).toBe("500.00");
  });

  test("rows with no text at all still fall back to the shape", () => {
    // Rows imported before the broker's text was kept have none and must keep working.
    const report = ostReport({
      txns: [
        deposit("2026-03-02", "900,00"),
        withdrawal("2026-03-05", "900,00"),
        deposit("2026-03-09", "900,00"),
      ],
      valueAt: worth("900,00"),
      from: "2026-01-01",
      to: "2026-12-31",
    });

    expect(report.withdrawals).toEqual([]);
  });
});

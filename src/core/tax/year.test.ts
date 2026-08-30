import { describe, expect, test } from "vitest";

import type { Disposal } from "../costbasis.ts";
import { EUR, formatMoney, parseFxRate, parseMoney, parseQuantity } from "../money.ts";
import type { IsoDate, TransactionType, Txn } from "../types.ts";
import { taxYear } from "./year.ts";

let nextId = 1;
const sale = (on: IsoDate, o: { proceeds: string; cost: string; accountId?: number }): Txn => ({
  id: nextId++,
  accountId: o.accountId ?? 1,
  instrumentId: 7,
  type: "SELL",
  tradeDate: on,
  quantity: parseQuantity("10"),
  unitPrice: null,
  amount: parseMoney(o.proceeds, EUR),
  fee: parseMoney("0", EUR),
  tax: parseMoney("0", EUR),
  currency: EUR,
  fxRateEur: parseFxRate("1", EUR),
});

const transfer = (type: TransactionType, on: IsoDate): Txn => ({
  ...sale(on, { proceeds: "0,00", cost: "0,00" }),
  type,
});

const disposalOf = (
  on: IsoDate,
  o: { proceeds: string; cost: string; accountId?: number },
): Disposal => ({
  accountId: o.accountId ?? 1,
  instrumentId: 7,
  acquiredOn: "2019-01-02",
  soldOn: on,
  quantity: parseQuantity("10"),
  proceedsEur: parseMoney(o.proceeds, EUR),
  feeEur: parseMoney("0", EUR),
  costEur: parseMoney(o.cost, EUR),
  gainEur: parseMoney("0", EUR),
});

/** A sale and the disposal it produced, which is how the real pipeline pairs them. */
const sold = (on: IsoDate, o: { proceeds: string; cost: string }) => ({
  txn: sale(on, o),
  disposal: disposalOf(on, o),
});

const base = {
  ostAccountIds: new Set<number>(),
  ostValueAt: () => ({
    ok: true as const,
    valueEur: parseMoney("0,00", EUR),
    pricedFrom: null,
    pricedFromInstrumentId: null,
  }),
};

const yearOf = (year: number, entries: readonly { txn: Txn; disposal: Disposal }[]) =>
  taxYear({
    ...base,
    year,
    txns: entries.map((e) => e.txn),
    disposals: entries.map((e) => e.disposal),
  });

describe("the small-sales exemption", () => {
  test("exempts a year whose sales total no more than 1 000 €", () => {
    const year = yearOf(2025, [sold("2025-06-01", { proceeds: "900,00", cost: "100,00" })]);

    expect(year.exempt).toBe(true);
    expect(formatMoney(year.netEur)).toBe("0.00");
  });

  test("includes exactly 1 000 € of sales", () => {
    const year = yearOf(2025, [sold("2025-06-01", { proceeds: "1000,00", cost: "100,00" })]);

    expect(year.exempt).toBe(true);
  });

  test("does not exempt a euro more", () => {
    const year = yearOf(2025, [sold("2025-06-01", { proceeds: "1000,01", cost: "100,00" })]);

    expect(year.exempt).toBe(false);
    // Not 900,01: the lot was held under ten years, so the 20 % deemed cost
    // (200,00) beats the actual 100,00 and the reported gain is the smaller
    // one the taxpayer is entitled to claim.
    expect(formatMoney(year.netEur)).toBe("800.01");
  });

  test("drops the year's losses too, since they are not deductible either", () => {
    // Reporting the exemption without this would overstate the carry-forward:
    // a year that owes nothing also gives nothing to later years.
    const year = yearOf(2025, [sold("2025-06-01", { proceeds: "400,00", cost: "900,00" })]);

    expect(year.exempt).toBe(true);
    expect(formatMoney(year.lossesEur)).toBe("0.00");
    expect(year.lossCarriedOut).toEqual([]);
  });
});

describe("losses", () => {
  test("net against the same year's gains first", () => {
    const year = yearOf(2025, [
      sold("2025-06-01", { proceeds: "5000,00", cost: "4000,00" }),
      sold("2025-07-01", { proceeds: "2000,00", cost: "2400,00" }),
    ]);

    expect(formatMoney(year.gainsEur)).toBe("1000.00");
    expect(formatMoney(year.lossesEur)).toBe("400.00");
    expect(formatMoney(year.netEur)).toBe("600.00");
  });

  test("carry into the fifth year", () => {
    const loss = sold("2020-06-01", { proceeds: "2000,00", cost: "3000,00" });
    const gain = sold("2025-06-01", { proceeds: "5000,00", cost: "4000,00" });
    const year = yearOf(2025, [loss, gain]);

    expect(year.lossCarriedIn).toHaveLength(1);
    expect(formatMoney(year.lossCarriedIn[0]!.amountEur)).toBe("1000.00");
    // The 2020 loss wipes out the 2025 gain exactly.
    expect(formatMoney(year.netEur)).toBe("0.00");
  });

  test("expire in the sixth", () => {
    const loss = sold("2020-06-01", { proceeds: "2000,00", cost: "3000,00" });
    const gain = sold("2026-06-01", { proceeds: "5000,00", cost: "4000,00" });
    const year = yearOf(2026, [loss, gain]);

    expect(year.lossCarriedIn).toEqual([]);
    expect(formatMoney(year.netEur)).toBe("1000.00");
  });

  test("are not reused once an intervening year has absorbed them", () => {
    // A carried loss consumed in 2023 must not reappear in 2025 -- the bug
    // that makes a carry-forward look inexhaustible.
    const year = yearOf(2025, [
      sold("2022-06-01", { proceeds: "2000,00", cost: "3000,00" }),
      sold("2023-06-01", { proceeds: "5000,00", cost: "4000,00" }),
      sold("2025-06-01", { proceeds: "5000,00", cost: "4000,00" }),
    ]);

    expect(year.lossCarriedIn).toEqual([]);
    expect(formatMoney(year.netEur)).toBe("1000.00");
  });
});

describe("what is not a disposal", () => {
  test("a transfer between the owner's own accounts", () => {
    // buildLots records a TRANSFER_OUT as a disposal so cost basis follows the
    // shares. Moving one's own shares is not a sale, and counting it would
    // report a gain nobody realised.
    const year = taxYear({
      ...base,
      year: 2025,
      txns: [transfer("TRANSFER_OUT", "2025-06-01"), transfer("TRANSFER_IN", "2025-06-01")],
      disposals: [disposalOf("2025-06-01", { proceeds: "5000,00", cost: "1000,00" })],
    });

    expect(year.disposals).toEqual([]);
    expect(formatMoney(year.netEur)).toBe("0.00");
  });

  test("a sale in a different year", () => {
    const year = yearOf(2025, [sold("2024-06-01", { proceeds: "5000,00", cost: "4000,00" })]);

    expect(year.disposals).toEqual([]);
  });
});

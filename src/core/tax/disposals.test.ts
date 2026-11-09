import { describe, expect, test } from "vitest";

import type { Disposal } from "../costbasis.ts";
import { EUR, formatMoney, parseMoney, parseQuantity } from "../money.ts";
import type { IsoDate } from "../types.ts";
import { taxableDisposals } from "./disposals.ts";

const disposal = (o: {
  acquiredOn: IsoDate;
  soldOn: IsoDate;
  proceeds: string;
  cost: string;
  fee?: string;
  accountId?: number;
}): Disposal => ({
  accountId: o.accountId ?? 1,
  instrumentId: 7,
  acquiredOn: o.acquiredOn,
  soldOn: o.soldOn,
  quantity: parseQuantity("10"),
  proceedsEur: parseMoney(o.proceeds, EUR),
  feeEur: parseMoney(o.fee ?? "0", EUR),
  costEur: parseMoney(o.cost, EUR),
  gainEur: parseMoney("0", EUR),
});

const only = (d: Disposal, ostAccountIds: ReadonlySet<number> = new Set()) =>
  taxableDisposals({ disposals: [d], ostAccountIds })[0]!;

describe("the deemed acquisition cost", () => {
  test("is taken when it beats the actual cost", () => {
    // Bought 100 €, sold 1 000 € after eleven years: gain 900 €, or 600 € with the 40 % deemed cost.
    const row = only(
      disposal({
        acquiredOn: "2014-01-10",
        soldOn: "2025-06-01",
        proceeds: "1000,00",
        cost: "100,00",
      }),
    );

    expect(row.deemedPercent).toBe(40n);
    expect(formatMoney(row.deemedGainEur)).toBe("600.00");
    expect(row.method).toBe("deemed");
    expect(formatMoney(row.gainEur)).toBe("600.00");
  });

  test("is 20 % below ten years", () => {
    const row = only(
      disposal({
        acquiredOn: "2016-06-02",
        soldOn: "2026-06-01",
        proceeds: "1000,00",
        cost: "100,00",
      }),
    );

    expect(row.deemedPercent).toBe(20n);
  });

  test("is 40 % on the tenth anniversary itself, which counts as at least ten years", () => {
    const row = only(
      disposal({
        acquiredOn: "2016-06-01",
        soldOn: "2026-06-01",
        proceeds: "1000,00",
        cost: "100,00",
      }),
    );

    expect(row.deemedPercent).toBe(40n);
  });

  test("never enlarges a loss", () => {
    // 20 % of 50 € would report a 40 € gain on a 50 € loss.
    const row = only(
      disposal({
        acquiredOn: "2024-01-10",
        soldOn: "2025-06-01",
        proceeds: "50,00",
        cost: "100,00",
      }),
    );

    expect(row.method).toBe("actual");
    expect(formatMoney(row.gainEur)).toBe("-50.00");
  });
});

describe("the two methods' bases", () => {
  test("differ by the sale fee", () => {
    // Actual-cost deducts the fee (net proceeds); deemed applies to the gross sale price.
    const row = only(
      disposal({
        acquiredOn: "2024-01-10",
        soldOn: "2025-06-01",
        proceeds: "990,00",
        fee: "10,00",
        cost: "100,00",
      }),
    );

    expect(formatMoney(row.netProceedsEur)).toBe("990.00");
    expect(formatMoney(row.grossProceedsEur)).toBe("1000.00");
    expect(formatMoney(row.actualGainEur)).toBe("890.00");
    expect(formatMoney(row.deemedCostEur)).toBe("200.00");
    expect(formatMoney(row.deemedGainEur)).toBe("800.00");
  });
});

describe("an equity savings account", () => {
  test("has no taxable disposals, because tax there falls on withdrawal", () => {
    // Counting the sale and the withdrawal would tax the same money twice.
    expect(
      taxableDisposals({
        disposals: [
          disposal({
            accountId: 7,
            acquiredOn: "2024-01-10",
            soldOn: "2025-06-01",
            proceeds: "1000,00",
            cost: "100,00",
          }),
        ],
        ostAccountIds: new Set([7]),
      }),
    ).toEqual([]);
  });

  test("does not suppress an ordinary account's disposal", () => {
    expect(
      taxableDisposals({
        disposals: [
          disposal({
            accountId: 1,
            acquiredOn: "2024-01-10",
            soldOn: "2025-06-01",
            proceeds: "1000,00",
            cost: "100,00",
          }),
        ],
        ostAccountIds: new Set([7]),
      }),
    ).toHaveLength(1);
  });
});

import { describe, expect, test } from "vitest";

import { addMoney, formatMoney, parseMoney, zeroMoney, EUR, type Money } from "../money.ts";
import type { DriftRow } from "./drift.ts";
import { attributeSale, rebalancePlan, type Trade } from "./plan.ts";

const row = (key: string, driftEur: string | null, untargeted = false): DriftRow => ({
  key,
  label: key,
  actualBp: 0,
  targetBp: untargeted ? null : 5000,
  driftBp: untargeted ? null : 1000,
  driftEur: driftEur === null ? null : parseMoney(driftEur, EUR),
  withinBand: false,
  untargeted,
});

const noGain = () => parseMoney("0,00", EUR);
const sideTotal = (trades: readonly Trade[], side: Trade["side"]): Money =>
  trades
    .filter((t) => t.side === side)
    .reduce((sum, t) => addMoney(sum, t.amountEur), zeroMoney(EUR));

describe("rebalancePlan", () => {
  test("sells the overweight and buys the underweight, and the two fund each other", () => {
    const plan = rebalancePlan({
      rows: [row("stock", "-1000,00"), row("fund", "1000,00")],
      gainOnSale: noGain,
    });

    expect(plan.trades.find((t) => t.key === "stock")!.side).toBe("sell");
    expect(plan.trades.find((t) => t.key === "fund")!.side).toBe("buy");
    // Self-funding: needs no new money and strands no cash.
    expect(formatMoney(sideTotal(plan.trades, "buy"))).toBe(
      formatMoney(sideTotal(plan.trades, "sell")),
    );
    expect(plan.balanced).toBe(true);
  });

  test("every sale names the gain it would realise", () => {
    // A sale must state the gain it realises.
    const plan = rebalancePlan({
      rows: [row("stock", "-1000,00"), row("fund", "1000,00")],
      gainOnSale: () => parseMoney("190,00", EUR),
    });

    const sale = plan.trades.find((t) => t.side === "sell")!;
    expect(formatMoney(sale.realisedGainEur!)).toBe("190.00");
    expect(formatMoney(plan.totalRealisedGainEur)).toBe("190.00");
    expect(plan.gainIncomplete).toBe(false);
  });

  test("a buy carries no gain at all, rather than a gain of zero", () => {
    // Buying realises nothing; 0,00 € would read as computed.
    const plan = rebalancePlan({ rows: [row("fund", "1000,00")], gainOnSale: noGain });
    expect(plan.trades[0]!.realisedGainEur).toBeNull();
    expect(plan.trades[0]!.gainUnknown).toBe(false);
  });

  test("a sale whose cost basis is unknown says so rather than claiming no gain", () => {
    const plan = rebalancePlan({ rows: [row("stock", "-1000,00")], gainOnSale: () => null });
    const sale = plan.trades[0]!;

    expect(sale.gainUnknown).toBe(true);
    expect(sale.realisedGainEur).toBeNull();
    expect(plan.gainIncomplete).toBe(true);
  });

  test("drops a trade below the floor and lists it", () => {
    // Below the floor: shown, not hidden.
    const plan = rebalancePlan({
      rows: [row("stock", "-3,00"), row("fund", "3,00")],
      gainOnSale: noGain,
    });

    expect(plan.trades).toEqual([]);
    expect(plan.tooSmall).toHaveLength(2);
  });

  test("never trades an untargeted slice", () => {
    const plan = rebalancePlan({
      rows: [row("stock", "-1000,00"), row("cash", null, true)],
      gainOnSale: noGain,
    });

    expect(plan.trades.every((t) => t.key !== "cash")).toBe(true);
  });

  test("has nothing to do when every slice can only be guessed at", () => {
    const plan = rebalancePlan({ rows: [row("stock", null)], gainOnSale: noGain });
    expect(plan.trades).toEqual([]);
    expect(plan.balanced).toBe(true);
  });
});

describe("attributeSale", () => {
  test("takes from the largest holding first, so the fewest positions are disturbed", () => {
    const parts = attributeSale(
      [
        { instrumentId: 1, valueEur: parseMoney("300,00", EUR) },
        { instrumentId: 2, valueEur: parseMoney("900,00", EUR) },
      ],
      parseMoney("500,00", EUR),
    );

    expect(parts).toHaveLength(1);
    expect(parts[0]!.instrumentId).toBe(2);
    expect(formatMoney(parts[0]!.amountEur)).toBe("500.00");
  });

  test("spills into the next holding when the largest cannot cover it", () => {
    const parts = attributeSale(
      [
        { instrumentId: 1, valueEur: parseMoney("300,00", EUR) },
        { instrumentId: 2, valueEur: parseMoney("900,00", EUR) },
      ],
      parseMoney("1000,00", EUR),
    );

    expect(parts.map((p) => formatMoney(p.amountEur))).toEqual(["900.00", "100.00"]);
  });

  test("stops at what the slice actually holds", () => {
    const parts = attributeSale(
      [{ instrumentId: 1, valueEur: parseMoney("300,00", EUR) }],
      parseMoney("500,00", EUR),
    );

    expect(formatMoney(parts[0]!.amountEur)).toBe("300.00");
  });
});

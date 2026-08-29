import { describe, expect, test } from "bun:test";

import { addMoney, formatMoney, parseMoney, zeroMoney, EUR } from "../money";
import { allocateDeposit, uncoveredAfterDeposit } from "./deposit";
import type { DriftRow } from "./drift";

const row = (key: string, actualBp: number): DriftRow => ({
  key,
  label: key,
  actualBp,
  targetBp: null,
  driftBp: null,
  driftEur: null,
  withinBand: false,
  untargeted: false,
});

const totalOf = (allocations: readonly { amountEur: ReturnType<typeof parseMoney> }[]) =>
  allocations.reduce((sum, a) => addMoney(sum, a.amountEur), zeroMoney(EUR));

describe("allocateDeposit", () => {
  test("sends the money where the gap is widest", () => {
    // 7 000 in shares and 3 000 in funds against 60/40. Depositing 1 000 makes
    // the total 11 000, so funds should hold 4 400 and are 1 400 short while
    // shares are already over: the whole deposit goes to funds.
    const allocations = allocateDeposit({
      rows: [row("stock", 7000), row("fund", 3000)],
      targets: [
        { key: "stock", weightBp: 6000 },
        { key: "fund", weightBp: 4000 },
      ],
      totalEur: parseMoney("10000,00", EUR),
      depositEur: parseMoney("1000,00", EUR),
    });

    expect(allocations).toHaveLength(1);
    expect(allocations[0]!.key).toBe("fund");
    expect(formatMoney(allocations[0]!.amountEur)).toBe("1000.00");
  });

  test("measures the shortfall after the deposit, not before it", () => {
    // Both slices sit exactly on target beforehand. Adding money changes every
    // weight, so both are underweight once it lands -- a rule measured on the
    // old total would find no gap at all and have nowhere to put the money.
    const allocations = allocateDeposit({
      rows: [row("stock", 5000), row("fund", 5000)],
      targets: [
        { key: "stock", weightBp: 5000 },
        { key: "fund", weightBp: 5000 },
      ],
      totalEur: parseMoney("10000,00", EUR),
      depositEur: parseMoney("1000,00", EUR),
    });

    expect(allocations.map((a) => formatMoney(a.amountEur)).sort()).toEqual(["500.00", "500.00"]);
  });

  test("the parts sum to exactly what was deposited, even when the split does not divide evenly", () => {
    const deposit = parseMoney("100,01", EUR);
    const allocations = allocateDeposit({
      rows: [row("a", 3334), row("b", 3333), row("c", 3333)],
      targets: [
        { key: "a", weightBp: 3334 },
        { key: "b", weightBp: 3333 },
        { key: "c", weightBp: 3333 },
      ],
      totalEur: parseMoney("0,00", EUR),
      depositEur: deposit,
    });

    // A split that loses a cent will not reconcile against the deposit it
    // describes.
    expect(formatMoney(totalOf(allocations))).toBe("100.01");
    expect(formatMoney(uncoveredAfterDeposit(allocations, deposit))).toBe("0.00");
  });

  test("never sends money to an untargeted slice", () => {
    const allocations = allocateDeposit({
      rows: [row("stock", 6000), row("cash", 4000)],
      targets: [{ key: "stock", weightBp: 10000 }],
      totalEur: parseMoney("10000,00", EUR),
      depositEur: parseMoney("500,00", EUR),
    });

    expect(allocations.every((a) => a.key !== "cash")).toBe(true);
  });

  test("puts money into a target the portfolio does not hold yet", () => {
    const allocations = allocateDeposit({
      rows: [row("stock", 10000)],
      targets: [
        { key: "stock", weightBp: 8000 },
        { key: "bond", weightBp: 2000 },
      ],
      totalEur: parseMoney("10000,00", EUR),
      depositEur: parseMoney("1000,00", EUR),
    });

    expect(allocations[0]!.key).toBe("bond");
  });

  test("returns nothing for a deposit of nothing", () => {
    expect(
      allocateDeposit({
        rows: [row("stock", 10000)],
        targets: [{ key: "stock", weightBp: 10000 }],
        totalEur: parseMoney("10000,00", EUR),
        depositEur: parseMoney("0,00", EUR),
      }),
    ).toEqual([]);
  });

  test("spreads a deposit larger than every gap by the target weights", () => {
    // Once the gaps are closed the rest has to follow the targets. Dumping the
    // excess into whichever slice was furthest behind would overshoot it and
    // open a new gap the other way.
    const allocations = allocateDeposit({
      rows: [row("stock", 5000), row("fund", 5000)],
      targets: [
        { key: "stock", weightBp: 5000 },
        { key: "fund", weightBp: 5000 },
      ],
      totalEur: parseMoney("1000,00", EUR),
      depositEur: parseMoney("9000,00", EUR),
    });

    expect(allocations.map((a) => formatMoney(a.amountEur)).sort()).toEqual(["4500.00", "4500.00"]);
    expect(formatMoney(totalOf(allocations))).toBe("9000.00");
  });
});

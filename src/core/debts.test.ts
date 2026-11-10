import { describe, expect, test } from "vitest";

import { firstBalanceDate, owedOn, owedSeries, type DebtBalance } from "./debts.ts";
import { EUR } from "./money.ts";

const eur = (minor: bigint) => ({ minor, currency: EUR });
const balances: DebtBalance[] = [
  { debtId: 1, asOf: "2026-01-10", owed: eur(1_000_00n) },
  { debtId: 1, asOf: "2026-03-01", owed: eur(900_00n) },
  { debtId: 2, asOf: "2026-02-01", owed: eur(50_00n) },
];

describe("owed on a day", () => {
  test("before the first balance nothing is owed", () => {
    expect(owedOn(balances, "2026-01-09").minor).toBe(0n);
  });
  test("the latest balance on or before the day counts, per debt", () => {
    expect(owedOn(balances, "2026-01-10").minor).toBe(1_000_00n);
    expect(owedOn(balances, "2026-02-15").minor).toBe(1_050_00n);
    expect(owedOn(balances, "2026-03-01").minor).toBe(950_00n);
  });
  test("input order does not matter", () => {
    expect(owedOn([...balances].reverse(), "2026-03-01").minor).toBe(950_00n);
  });
  test("the series is a step line with one point per day", () => {
    const series = owedSeries(balances, "2026-02-27", "2026-03-02");
    expect(series.map((p) => p.owedEur.minor)).toEqual([1_050_00n, 1_050_00n, 950_00n, 950_00n]);
    expect(series[0]?.date).toBe("2026-02-27");
  });
  test("no balances: zero series and no first date", () => {
    expect(owedSeries([], "2026-01-01", "2026-01-02").every((p) => p.owedEur.minor === 0n)).toBe(
      true,
    );
    expect(firstBalanceDate([])).toBeNull();
    expect(firstBalanceDate(balances)).toBe("2026-01-10");
  });
});

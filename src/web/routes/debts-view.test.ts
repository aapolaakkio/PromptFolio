import { describe, expect, test } from "vitest";

import { stepPoints } from "./debts-view.ts";

describe("stepPoints", () => {
  test("no balances give no points", () => {
    expect(stepPoints([], "2026-11-10")).toEqual([]);
  });

  test("two balances give a hold point before the later one and end at today with the last value", () => {
    const points = stepPoints(
      [
        { asOf: "2026-03-01", owedEur: "1000.00" },
        { asOf: "2026-06-01", owedEur: "800.50" },
      ],
      "2026-11-10",
    );

    expect(points).toEqual([
      { date: "2026-03-01", value: 1000 },
      { date: "2026-05-31", value: 1000 },
      { date: "2026-06-01", value: 800.5 },
      { date: "2026-11-10", value: 800.5 },
    ]);
  });

  test("balances given newest first still come out oldest first", () => {
    const points = stepPoints(
      [
        { asOf: "2026-06-01", owedEur: "800.50" },
        { asOf: "2026-03-01", owedEur: "1000.00" },
      ],
      "2026-11-10",
    );

    expect(points.map((point) => point.date)).toEqual([
      "2026-03-01",
      "2026-05-31",
      "2026-06-01",
      "2026-11-10",
    ]);
  });

  test("a balance dated today adds no duplicate point", () => {
    const points = stepPoints([{ asOf: "2026-11-10", owedEur: "50.00" }], "2026-11-10");

    expect(points).toEqual([{ date: "2026-11-10", value: 50 }]);
  });

  test("the hold point is the day before, across a month edge", () => {
    const points = stepPoints(
      [
        { asOf: "2026-01-10", owedEur: "1000.00" },
        { asOf: "2026-03-01", owedEur: "900.00" },
      ],
      "2026-03-10",
    );

    expect(points).toEqual([
      { date: "2026-01-10", value: 1000 },
      { date: "2026-02-28", value: 1000 },
      { date: "2026-03-01", value: 900 },
      { date: "2026-03-10", value: 900 },
    ]);
  });

  test("consecutive days get no hold point", () => {
    const points = stepPoints(
      [
        { asOf: "2026-01-10", owedEur: "1000.00" },
        { asOf: "2026-01-11", owedEur: "900.00" },
      ],
      "2026-01-11",
    );

    expect(points).toEqual([
      { date: "2026-01-10", value: 1000 },
      { date: "2026-01-11", value: 900 },
    ]);
  });
});

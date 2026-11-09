import { describe, expect, test } from "vitest";

import {
  appendRow,
  bankBalanceCheck,
  holdingsTotalCheck,
  pickSuggested,
  problemToRow,
  removeRow,
  updateRow,
} from "./draft-edit.ts";

test("row edits return new arrays and leave the input alone", () => {
  const rows = [{ a: 1 }, { a: 2 }];
  expect(updateRow(rows, 1, { a: 3 })).toEqual([{ a: 1 }, { a: 3 }]);
  expect(removeRow(rows, 0)).toEqual([{ a: 2 }]);
  expect(appendRow(rows, { a: 9 })).toEqual([{ a: 1 }, { a: 2 }, { a: 9 }]);
  expect(rows).toEqual([{ a: 1 }, { a: 2 }]);
});

test("the balance check follows the edit, in cents, and tolerates a decimal comma", () => {
  const draft = {
    statement: { openingBalanceEur: "1500,00", closingBalanceEur: "1474.10" },
    rows: [{ amountEur: "-25.90" }],
  };
  expect(bankBalanceCheck(draft)).toEqual({ ok: true, differenceEur: "0.00" });
  expect(bankBalanceCheck({ ...draft, rows: [{ amountEur: "-35.90" }] })).toEqual({
    ok: false,
    differenceEur: "10.00",
  });
  expect(bankBalanceCheck({ ...draft, rows: [{ amountEur: "paljon" }] })).toEqual({
    ok: false,
    differenceEur: "?",
  });
  expect(bankBalanceCheck({ statement: null, rows: [] })).toBeNull();
});

test("the holdings total check does the same for values", () => {
  expect(
    holdingsTotalCheck([{ marketValueEur: "40" }, { marketValueEur: "960" }], "1000.00"),
  ).toEqual({ ok: true, differenceEur: "0.00" });
  expect(holdingsTotalCheck([{ marketValueEur: "40" }], null)).toBeNull();
});

describe("problemToRow with a suggestion", () => {
  const problem = { line: 4, text: "Unrecognised line: 05.02.2024 Prisma -45,60" };

  test("without a suggestion the row is blank, as before", () => {
    expect(problemToRow(problem)).toMatchObject({ date: "", amountEur: "", counterparty: "" });
  });

  test("a suggestion prefills only the fields it names and keeps the printed text", () => {
    const row = problemToRow({
      ...problem,
      suggestion: { date: "2024-02-05", type: "WITHDRAWAL", amountEur: "-45.60", other: "x" },
    });
    expect(row).toMatchObject({
      date: "2024-02-05",
      type: "WITHDRAWAL",
      amountEur: "-45.60",
      counterparty: "",
      message: problem.text,
    });
  });

  test("a type the page does not offer is ignored", () => {
    expect(problemToRow({ ...problem, suggestion: { type: "GIFT" } }).type).toBe("DEPOSIT");
  });
});

describe("pickSuggested", () => {
  test("keeps only the listed keys", () => {
    expect(pickSuggested({ a: "1", b: "2" }, ["a", "c"])).toEqual({ a: "1" });
    expect(pickSuggested(undefined, ["a"])).toEqual({});
  });
});

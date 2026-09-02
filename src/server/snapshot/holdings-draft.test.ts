import { expect, test } from "vitest";

import { holdingsTotalCheck } from "./holdings-draft.ts";

test("the rows' values must reach the printed total, to the cent", () => {
  const rows = [{ marketValueEur: "40.00" }, { marketValueEur: "960,00" }];
  expect(holdingsTotalCheck(rows, "1000.00")).toEqual({ ok: true, differenceEur: "0.00" });
  expect(holdingsTotalCheck(rows, "1001.00")).toEqual({ ok: false, differenceEur: "1.00" });
});

test("no printed total, nothing to check", () => {
  expect(holdingsTotalCheck([{ marketValueEur: "1.00" }], null)).toBeNull();
});

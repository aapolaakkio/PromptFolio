import { describe, expect, test } from "bun:test";

import { NORDNET } from "./brokers";
import { portfoliosNamed } from "./portfolios";
import type { RawRow } from "./types";

// Nordnet's export names the column `Salkku`, so the parser hands it over in
// `values` under that heading; `cells` matters only for a config that addresses
// a repeated header positionally (Nordnet's five `Valuutta` columns).
const row = (portfolio: string, line: number): RawRow => ({
  line,
  cells: [],
  values: { Salkku: portfolio },
});

describe("portfoliosNamed", () => {
  test("names each account once, in the order it first appears", () => {
    const rows = [row("11223344", 2), row("55667788", 3), row("11223344", 4)];
    expect(portfoliosNamed(rows, NORDNET)).toEqual(["11223344", "55667788"]);
  });

  test("a single-account file names one, which the caller lets through", () => {
    expect(portfoliosNamed([row("11223344", 2), row("11223344", 3)], NORDNET)).toEqual([
      "11223344",
    ]);
  });

  test("ignores blank cells rather than counting them as an account", () => {
    expect(portfoliosNamed([row("11223344", 2), row("   ", 3)], NORDNET)).toEqual(["11223344"]);
  });

  test("a broker whose export has no such column names none", () => {
    const noColumn = { columns: {}, columnPositions: undefined };
    expect(portfoliosNamed([row("11223344", 2)], noColumn)).toEqual([]);
  });

  test("reads a positional config too, for a header a broker repeats", () => {
    const byPosition = { columns: {}, columnPositions: { portfolio: 5 } };
    const rows: RawRow[] = [
      { line: 2, cells: ["1", "", "", "", "AOT-1"], values: {} },
      { line: 3, cells: ["2", "", "", "", "OST-2"], values: {} },
    ];
    expect(portfoliosNamed(rows, byPosition)).toEqual(["AOT-1", "OST-2"]);
  });
});

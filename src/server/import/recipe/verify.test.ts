import { describe, expect, test } from "vitest";

import { EUR, money } from "../../../core/money.ts";
import { readText } from "../../files.ts";
import { OP_STATEMENT_RECIPE } from "./op-reference.ts";
import { type RecipeRun, runRecipe } from "./run.ts";
import { verifyRun } from "./verify.ts";

const run = (
  over: Partial<RecipeRun["statement"]> = {},
  unclaimed: RecipeRun["unclaimed"] = [],
  skipped: RecipeRun["skipped"] = [],
): RecipeRun => ({
  statement: {
    from: "2025-08-28",
    to: "2026-08-28",
    openingBalance: money(150_000n, EUR),
    closingBalance: money(323_644n, EUR),
    rows: [
      {
        line: 3,
        date: "2025-08-28",
        type: "WITHDRAWAL",
        amount: -2590n,
        counterparty: "K-MARKET",
        note: "K-MARKET",
        externalId: null,
      },
      {
        line: 8,
        date: "2025-08-29",
        type: "DEPOSIT",
        amount: 176_234n,
        counterparty: "TYONANTAJA",
        note: "TYONANTAJA",
        externalId: null,
      },
    ],
    problems: [],
    maturityDate: null,
    ...over,
  },
  rowBalances: [],
  unclaimed,
  skipped,
});

describe("verifyRun", () => {
  test("passes when the rows add up and every line was claimed", () => {
    expect(verifyRun(run())).toEqual({ ok: true });
  });

  test("fails when the rows do not reach the printed closing balance", () => {
    const verdict = verifyRun(run({ closingBalance: money(999_999n, EUR) }));

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.report).toMatch(/Balance check/);
  });

  test("names the difference so the model can see a sign error", () => {
    const verdict = verifyRun(run({ closingBalance: money(328_824n, EUR) }));

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.report).toContain("51.80");
  });

  test("fails when an unclaimed line looks like a transaction, and quotes it", () => {
    const verdict = verifyRun(run({}, [{ line: 7, text: "28.08.2025 -25,90 K-MARKET" }]));

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.report).toContain("28.08.2025 -25,90 K-MARKET");
  });

  test("passes over unclaimed lines that carry no transaction, whatever their number", () => {
    const detail = [
      { line: 4, text: "VIESTI" },
      { line: 5, text: "SEPA-MAKSU" },
      { line: 6, text: "Maksajan viite:" },
      { line: 7, text: "T20250101-000000" },
      { line: 9, text: "Kolikot yht 12,34 EUR" },
      { line: 10, text: "Examplebank Oy, Y-tunnus 0000000-0, PL 1, 00100 Helsinki" },
    ];

    expect(verifyRun(run({}, detail))).toEqual({ ok: true });
  });

  test("fails when a row's date falls outside the statement's period", () => {
    const outside = run();
    const verdict = verifyRun({
      ...outside,
      statement: {
        ...outside.statement,
        rows: [{ ...outside.statement.rows[0]!, date: "2030-01-01" }, outside.statement.rows[1]!],
      },
    });

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.report).toMatch(/2030-01-01/);
  });

  test("lists at most ten unclaimed lines", () => {
    const many = Array.from({ length: 25 }, (_, at) => ({
      line: at,
      text: `28.08.2025 -25,90 rivi ${at}`,
    }));
    const verdict = verifyRun(run({}, many));

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.report.match(/rivi \d+/g)).toHaveLength(10);
  });

  test("tolerates an unclaimed line before the first row when rows are present", () => {
    const verdict = verifyRun(run({}, [{ line: 1, text: "28.08.2025 -25,90 EXAMPLE ASIAKAS" }]));

    expect(verdict).toEqual({ ok: true });
  });

  test("does not tolerate a preamble line when there are no rows at all", () => {
    const verdict = verifyRun(
      run({ rows: [], closingBalance: money(150_000n, EUR) }, [
        { line: 1, text: "28.08.2025 -25,90 K-MARKET" },
      ]),
    );

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.report).toContain("28.08.2025 -25,90 K-MARKET");
  });

  test("fails and names only the unclaimed line at or after the first row", () => {
    const verdict = verifyRun(
      run({}, [
        { line: 1, text: "28.08.2025 -25,90 EXAMPLE ASIAKAS" },
        { line: 7, text: "28.08.2025 -25,90 K-MARKET" },
      ]),
    );

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.report).toContain("K-MARKET");
      expect(verdict.report).not.toContain("EXAMPLE ASIAKAS");
    }
  });
});

const OP_FURNITURE = [
  "Tilinumero FI00 0000 0000 0000 00",
  "BIC OKOYFIHH",
  "Kirjaus-",
  "päivä",
  "Arvopäivä",
  "Määrä,",
  "euroa",
  "Selitys",
  "Maksunsaaja/maksaja",
  "Viesti",
  "Viite Arkistointitunnus",
  "Saajan tilinumero",
  "Saajan pankin BIC",
  "400000******0000 OSTOPVM 250828",
  "MF NRO 00000000000000000000000",
  "VARMENTAJA 400",
  "Tiliote",
  "Käyttötili",
  "Ajalta",
  "29.8.2025 - 28.8.2026",
  "1 (1)",
  "Määräaikainen säästötili",
  "1.2.2026 - 28.2.2026",
  "Eräpäivä",
  "FI00 0000 0000 0000 00",
  "OKOYFIHH",
  "1.2.2027",
  "5 000,00 Panot yhteensä 1 kpl",
  "0,00 Otot yhteensä 0 kpl",
  "Asiakkaan tulostama 1.3.2026",
];

describe("verifyRun -- money hidden by skip", () => {
  test("fails when a skipped line carries both a date and an amount", () => {
    const verdict = verifyRun(run({}, [], [{ line: 5, text: "1.9.2026 −250,00 SIIRTO" }]));

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.report).toContain("1.9.2026 −250,00 SIIRTO");
  });

  test("names every such line, so the retry can act on it", () => {
    const verdict = verifyRun(
      run(
        {},
        [],
        [
          { line: 5, text: "1.9.2026 −250,00 SIIRTO" },
          { line: 6, text: "2.9.2026 +250,00 SIIRTO" },
        ],
      ),
    );

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.report).toContain("1.9.2026 −250,00 SIIRTO");
      expect(verdict.report).toContain("2.9.2026 +250,00 SIIRTO");
    }
  });

  test("does not trip on any real piece of page furniture", () => {
    const skipped = OP_FURNITURE.map((text, at) => ({ line: at + 1, text }));

    expect(verifyRun(run({}, [], skipped))).toEqual({ ok: true });
  });

  test("a skipped line with only a date, or only an amount, is furniture", () => {
    const skipped = [
      { line: 1, text: "Asiakkaan tulostama 1.3.2026" },
      { line: 2, text: "5 000,00 Panot yhteensä 1 kpl" },
    ];

    expect(verifyRun(run({}, [], skipped))).toEqual({ ok: true });
  });
});

const EVASIONS = [
  "1.8.26 −250,00 SIIRTO",
  "29/08/2025 −250,00 SIIRTO",
  "2025.08.29 −250,00 SIIRTO",
  "29-08-2025 −250,00 SIIRTO",
  "2025-08-29 −250,00 SIIRTO",
  "1.9.2026 -250 SIIRTO",
  "1.9.2026 -250,000 SIIRTO",
  "1.9.2026 250 SIIRTO",
  "1.9.2026 1 250 SIIRTO",
  "1.8.26 -250 SIIRTO",
];

describe("verifyRun -- skip evasions", () => {
  test.each(EVASIONS)("catches %s", (text) => {
    const verdict = verifyRun(run({}, [], [{ line: 5, text }]));

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.report).toContain(text);
  });

  test("still lets every real piece of page furniture through", () => {
    const skipped = OP_FURNITURE.map((text, at) => ({ line: at + 1, text }));

    expect(verifyRun(run({}, [], skipped))).toEqual({ ok: true });
  });
});

describe("verifyRun -- the reference recipe on the real fixtures", () => {
  const fixture = (name: string): Promise<string> =>
    readText(`${import.meta.dirname}/../fixtures/${name}`);

  test.each(["op-statement-sample.txt", "op-fixed-term-sample.txt"])(
    "%s verifies clean, with no skipped line flagged",
    async (name) => {
      expect(verifyRun(runRecipe(await fixture(name), OP_STATEMENT_RECIPE))).toEqual({ ok: true });
    },
  );
});

describe("the running balance a statement prints after each row", () => {
  const chained = (balances: readonly (bigint | null)[]): RecipeRun => ({
    ...run(),
    rowBalances: balances,
  });

  test("passes when every row agrees with the balance printed beside it", () => {
    expect(verifyRun(chained([147_410n, 323_644n]))).toEqual({ ok: true });
  });

  test("fails and names the first row whose printed balance disagrees", () => {
    const verdict = verifyRun(chained([147_410n, 999_999n]));

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.report).toMatch(/running balance/i);
  });

  test("says nothing when the statement prints no running balance", () => {
    expect(verifyRun(chained([null, null]))).toEqual({ ok: true });
  });
});

import { readText } from "../files.ts";
import { describe, expect, test } from "vitest";

import { verifyStatement } from "./bank-pdf.ts";
import { isSweepStatement, parseSweepStatementText } from "./bank-pdf-sweep.ts";

// SweepBank writes English and the English number format, where a comma groups
// thousands and a dot separates cents -- the reverse of OP's. Reading
// "1,197.93" with Finnish rules would give 119 793,00, so the fixture keeps
// that exact shape, along with the multi-line blocks a transaction is made of.
// Verified against a real statement: two rows, and the printed end balance
// reached exactly.

const fixture = (): Promise<string> =>
  readText(`${import.meta.dirname}/fixtures/sweep-statement-sample.txt`);

describe("isSweepStatement", () => {
  test("recognises the document by its own words, not the file name", async () => {
    expect(isSweepStatement(await fixture())).toBe(true);
  });

  test("does not claim an OP statement", () => {
    expect(isSweepStatement("+100,00 Saldo 28.8.2025\nTiliote\nKäyttötili")).toBe(false);
  });
});

describe("parseSweepStatementText", () => {
  test("reads the period and the balances from the totals line", async () => {
    const statement = parseSweepStatementText(await fixture());

    expect(statement.from).toBe("2026-08-01");
    expect(statement.to).toBe("2026-08-29");
    expect(statement.openingBalance.minor).toBe(119_793n);
    expect(statement.closingBalance.minor).toBe(169_550n);
  });

  test("reads a comma as a thousands separator, not as a decimal point", async () => {
    const statement = parseSweepStatementText(await fixture());
    // 1,197.93 is one thousand one hundred and ninety-seven euros, not 119 793.
    expect(statement.openingBalance.minor).toBe(119_793n);
  });

  test("collects a transaction from the block of lines it spans", async () => {
    const { rows } = parseSweepStatementText(await fixture());

    expect(rows).toHaveLength(3);
    expect(rows[0]?.date).toBe("2026-08-08");
    expect(rows[0]?.amount).toBe(7n);
    expect(rows[0]?.externalId).toBe("2026080822258681");
  });

  test("takes the sign from the line rather than the wording", async () => {
    const { rows } = parseSweepStatementText(await fixture());

    expect(rows[1]?.amount).toBe(-250n);
    expect(rows[1]?.type).toBe("WITHDRAWAL");
  });

  test("reads an amount printed without cents", async () => {
    const { rows } = parseSweepStatementText(await fixture());
    expect(rows[2]?.amount).toBe(50_000n);
  });

  test("names an interest payment, and leaves the IBAN out of the note", async () => {
    const { rows } = parseSweepStatementText(await fixture());

    expect(rows[0]?.type).toBe("INTEREST");
    expect(rows[0]?.note).toBe("Esimerkki Asiakas — Interest payment");
    expect(rows[2]?.note).toBe("Periodical transaction to saving account");
  });

  test("refuses a document with no totals line rather than importing rows alone", () => {
    expect(() => parseSweepStatementText("Savings Account Statement\n2026-08-01\n")).toThrow(
      /alku- ja loppusaldoa/,
    );
  });

  test("refuses one whose period it cannot read", () => {
    const noPeriod = [
      "Savings Account Statement",
      "COUNT CREDIT TURNOVER DEBIT TURNOVER INITIAL BALANCE END BALANCE",
      "1 10.00 EUR -0 EUR 100.00 EUR 110.00 EUR",
    ].join("\n");
    expect(() => parseSweepStatementText(noPeriod)).toThrow(/jaksoa/);
  });
});

describe("verification", () => {
  test("the rows account for the difference between the printed balances", async () => {
    const statement = parseSweepStatementText(await fixture());
    // 1197,93 + 0,07 - 2,50 + 500,00 = 1695,50
    expect(verifyStatement(statement).ok).toBe(true);
  });
});

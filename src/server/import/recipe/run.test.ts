import { describe, expect, test } from "vitest";

import { runRecipe } from "./run.ts";
import type { BankRecipe } from "./types.ts";

const recipe: BankRecipe = {
  kind: "bank",
  skip: ["^Tiliote$", String.raw`^\d+ \(\d+\)$`],
  recordStart: String.raw`^(?<date>\d{1,2}\.\d{1,2}\.\d{4})\s+(?<amount>[+−\-][\d  ]*,\d{2})\s+(?<label>[A-ZÄÖÅ][A-ZÄÖÅ.\- ]*?)(?:\s+(?<externalId>[0-9A-Z]{16,}))?\s*$`,
  continuation: [String.raw`^Viesti:\n(?<message>.+)$`],
  restField: "counterparty",
  header: {
    from: String.raw`^(?:[+−\-][\d  ]*,\d{2})\s+Saldo\s+(?<value>\d{1,2}\.\d{1,2}\.\d{4})$`,
    to: String.raw`^(?:[+−\-][\d  ]*,\d{2})\s+Saldo\s+(?<value>\d{1,2}\.\d{1,2}\.\d{4})$`,
    openingBalance: String.raw`^(?<value>[+−\-][\d  ]*,\d{2})\s+Saldo\s+\d`,
    closingBalance: String.raw`^(?<value>[+−\-][\d  ]*,\d{2})\s+Saldo\s+\d`,
  },
  dateFormat: "d.m.yyyy",
  money: { decimal: ",", thousands: " ", negative: "leading", twoColumn: false },
};

const doc = [
  "Tiliote",
  "+1 500,00 Saldo 28.8.2025",
  "28.8.2025 −25,90 PKORTTIMAKSU 20250828A1B2C3D4E5F6",
  "K-MARKET ESIMERKKI",
  "Viesti:",
  "Kahvia",
  "1 (2)",
  "29.8.2025 +2 750,00 TILISIIRTO",
  "TYONANTAJA OY",
  "+3 236,44 Saldo 28.8.2026",
].join("\n");

describe("runRecipe", () => {
  test("reads the period and both balances from the header patterns", () => {
    const { statement } = runRecipe(doc, recipe);

    expect(statement.from).toBe("2025-08-28");
    expect(statement.to).toBe("2026-08-28");
    expect(statement.openingBalance.minor).toBe(150_000n);
    expect(statement.closingBalance.minor).toBe(323_644n);
  });

  test("reads every record, with its sign", () => {
    const { statement } = runRecipe(doc, recipe);

    expect(statement.rows.map((row) => row.amount)).toEqual([-2590n, 275_000n]);
  });

  test("takes the counterparty from the first unclaimed block line", () => {
    const { statement } = runRecipe(doc, recipe);

    expect(statement.rows[0]?.counterparty).toBe("K-MARKET ESIMERKKI");
    expect(statement.rows[1]?.counterparty).toBe("TYONANTAJA OY");
  });

  test("a continuation pattern may span two lines", () => {
    const { statement } = runRecipe(doc, recipe);

    expect(statement.rows[0]?.note).toContain("Kahvia");
  });

  test("reads the archive id named on the record-start line", () => {
    const { statement } = runRecipe(doc, recipe);

    expect(statement.rows[0]?.externalId).toBe("20250828A1B2C3D4E5F6");
    expect(statement.rows[1]?.externalId).toBeNull();
  });

  test("types a row by its sign", () => {
    const { statement } = runRecipe(doc, recipe);

    expect(statement.rows.map((row) => row.type)).toEqual(["WITHDRAWAL", "DEPOSIT"]);
  });

  test("types money arriving as interest when the record says korko", () => {
    const withInterest = doc.replace("TILISIIRTO", "TALLETUSKORKO");
    const { statement } = runRecipe(withInterest, recipe);

    expect(statement.rows[1]?.type).toBe("INTEREST");
  });

  test("claims every line of a document the recipe fully describes", () => {
    expect(runRecipe(doc, recipe).unclaimed).toEqual([]);
  });

  test("reports a block line no pattern claimed", () => {
    const withNoise = doc.replace("K-MARKET ESIMERKKI", "K-MARKET ESIMERKKI\nOSTOPVM 28.08.2025");
    const { unclaimed } = runRecipe(withNoise, recipe);

    expect(unclaimed.map((entry) => entry.text)).toEqual(["OSTOPVM 28.08.2025"]);
  });

  test("a record whose amount cannot be read becomes a problem, not an exception", () => {
    const broken = doc.replace("−25,90", "−,90");
    const { statement } = runRecipe(broken, recipe);

    expect(statement.rows).toHaveLength(1);
    expect(statement.problems).toHaveLength(1);
  });

  test("refuses a document whose balances the recipe cannot find", () => {
    const noBalances = doc.replace(/.*Saldo.*\n?/g, "");
    expect(() => runRecipe(noBalances, recipe)).toThrow(/saldo/i);
  });
});

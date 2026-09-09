import { describe, expect, test } from "vitest";

import { runRecipe } from "./run.ts";
import { verifyRun } from "./verify.ts";
import { parseRecipe, type BankRecipe } from "./types.ts";

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

describe("runRecipe -- round 2 regressions", () => {
  test("does not swallow a block line when restField's target was already set by a continuation match", () => {
    const critical1Recipe: BankRecipe = {
      ...recipe,
      continuation: [...recipe.continuation, String.raw`^CP:(?<counterparty>.+)$`],
    };
    const critical1Doc = doc.replace(
      "K-MARKET ESIMERKKI\nViesti:\nKahvia",
      "FIRSTLINE\nCP:FROMCONT",
    );

    const { statement, unclaimed } = runRecipe(critical1Doc, critical1Recipe);

    expect(statement.rows[0]?.counterparty).toBe("FROMCONT");
    expect(unclaimed.map((entry) => entry.text)).toContain("FIRSTLINE");
  });

  test("reports every line as unclaimed when no line opens a record at all", () => {
    const docLines = doc.split("\n");
    const openingLine = docLines[1];
    const closingLine = docLines[9];
    const noRecordsDoc = [openingLine, "ROSKAA A", "ROSKAA B", closingLine].join("\n");

    const { statement, unclaimed } = runRecipe(noRecordsDoc, recipe);

    expect(statement.rows).toEqual([]);
    expect(statement.problems).toEqual([]);
    expect(unclaimed.map((entry) => entry.text)).toEqual(["ROSKAA A", "ROSKAA B"]);
  });

  test("skip wins over recordStart: a line matching both never opens a record", () => {
    const skipWinsRecipe: BankRecipe = { ...recipe, skip: [...recipe.skip, String.raw`^28\.`] };

    const { statement } = runRecipe(doc, skipWinsRecipe);

    expect(statement.rows).toHaveLength(1);
    expect(statement.rows[0]?.date).toBe("2025-08-29");
  });

  test("recordStart's own named group wins over restField, leaving the rest line unclaimed", () => {
    const precedenceRecipe: BankRecipe = {
      kind: "bank",
      skip: [],
      recordStart: String.raw`^(?<date>\d{1,2}\.\d{1,2}\.\d{4})\s+(?<amount>[+\-]\d+,\d{2})\s+(?<label>[A-Z]+)\s+(?<counterparty>[A-Z ]+)$`,
      continuation: [],
      restField: "counterparty",
      header: {
        from: String.raw`^(?<value>\d{1,2}\.\d{1,2}\.\d{4})\s+Saldo$`,
        to: String.raw`^(?<value>\d{1,2}\.\d{1,2}\.\d{4})\s+Saldo$`,
        openingBalance: String.raw`^(?<value>[+\-]\d+,\d{2})\s+Saldo$`,
        closingBalance: String.raw`^(?<value>[+\-]\d+,\d{2})\s+Saldo$`,
      },
      dateFormat: "d.m.yyyy",
      money: { decimal: ",", thousands: "", negative: "leading", twoColumn: false },
    };
    const precedenceDoc = [
      "28.8.2025 Saldo",
      "+0,00 Saldo",
      "1.9.2025 +5,00 PALKKA TYONANTAJA OY",
      "MUU RIVI",
      "30.9.2025 Saldo",
      "+5,00 Saldo",
    ].join("\n");

    const { statement, unclaimed } = runRecipe(precedenceDoc, precedenceRecipe);

    expect(statement.rows).toHaveLength(1);
    expect(statement.rows[0]?.counterparty).toBe("TYONANTAJA OY");
    expect(unclaimed.map((entry) => entry.text)).toContain("MUU RIVI");
  });

  test("throws the Finnish time-budget error on a per-line basis, not just per record", () => {
    const docLines = doc.split("\n");
    const openingLine = docLines[1];
    const closingLine = docLines[9];
    const filler = Array.from({ length: 250 }, (_, index) => `ROSKAA ${index}`);
    const bigDoc = [openingLine, ...filler, closingLine].join("\n");

    expect(() => runRecipe(bigDoc, recipe, -1)).toThrow(/kesti liian kauan/);
  });

  test("claims the lines a multi-line header fallback match covers, so they don't leak into a record block", () => {
    const maturityRecipe: BankRecipe = {
      kind: "bank",
      skip: [],
      recordStart: String.raw`^(?<date>\d{1,2}\.\d{1,2}\.\d{4})\s+(?<amount>[+\-]\d+,\d{2})\s+(?<label>[A-Z]+)$`,
      continuation: [],
      restField: "counterparty",
      header: {
        from: String.raw`^(?<value>\d{1,2}\.\d{1,2}\.\d{4})\s+Saldo$`,
        to: String.raw`^(?<value>\d{1,2}\.\d{1,2}\.\d{4})\s+Saldo$`,
        openingBalance: String.raw`^(?<value>[+\-]\d+,\d{2})\s+Saldo$`,
        closingBalance: String.raw`^(?<value>[+\-]\d+,\d{2})\s+Saldo$`,
        maturityDate: String.raw`^Eräpäivä\s*\n(?<value>\d{1,2}\.\d{1,2}\.\d{4})$`,
      },
      dateFormat: "d.m.yyyy",
      money: { decimal: ",", thousands: "", negative: "leading", twoColumn: false },
    };
    const maturityDoc = [
      "28.8.2025 Saldo",
      "+0,00 Saldo",
      "1.9.2025 +5,00 PALKKA",
      "Eräpäivä",
      "1.2.2027",
      "30.9.2025 Saldo",
      "+5,00 Saldo",
    ].join("\n");

    const { statement, unclaimed } = runRecipe(maturityDoc, maturityRecipe);

    expect(statement.maturityDate).toBe("2027-02-01");
    expect(statement.rows[0]?.counterparty).toBe("");
    expect(unclaimed).toEqual([]);
  });
});

describe("runRecipe -- round 3 regressions", () => {
  test("a greedy header fallback match only claims its first and last line, reporting what's swallowed between them", () => {
    const greedyRecipe: BankRecipe = {
      kind: "bank",
      skip: [],
      recordStart: String.raw`^(?<date>\d{1,2}\.\d{1,2}\.\d{4})\s+(?<amount>[+\-]\d+,\d{2})\s+(?<label>[A-Z]+)$`,
      continuation: [],
      restField: null,
      header: {
        from: String.raw`^(?<value>\d{1,2}\.\d{1,2}\.\d{4})\s+Saldo$`,
        to: String.raw`^(?<value>\d{1,2}\.\d{1,2}\.\d{4})\s+Saldo$`,
        openingBalance: String.raw`^(?<value>[+\-]\d+,\d{2})\s+Saldo$`,
        closingBalance: String.raw`^(?<value>[+\-]\d+,\d{2})\s+Saldo$`,
        maturityDate: String.raw`Eräpäivä[\s\S]*?(?<value>\d{1,2}\.\d{1,2}\.\d{4})`,
      },
      dateFormat: "d.m.yyyy",
      money: { decimal: ",", thousands: "", negative: "leading", twoColumn: false },
    };
    const greedyDoc = [
      "28.8.2025 Saldo",
      "+0,00 Saldo",
      "1.9.2025 +5,00 PALKKA",
      "Eräpäivä",
      "JOTAIN",
      "VIELA JOTAIN",
      "1.2.2027",
      "30.9.2025 Saldo",
      "+5,00 Saldo",
    ].join("\n");

    const { statement, unclaimed } = runRecipe(greedyDoc, greedyRecipe);

    expect(statement.maturityDate).toBe("2027-02-01");
    expect(unclaimed).toEqual([
      { line: 5, text: "JOTAIN" },
      { line: 6, text: "VIELA JOTAIN" },
    ]);
  });

  test("the ordinary two-line header (label, then its value) still comes back with unclaimed empty", () => {
    const twoLineRecipe: BankRecipe = {
      kind: "bank",
      skip: [],
      recordStart: String.raw`^(?<date>\d{1,2}\.\d{1,2}\.\d{4})\s+(?<amount>[+\-]\d+,\d{2})\s+(?<label>[A-Z]+)$`,
      continuation: [],
      restField: null,
      header: {
        from: String.raw`^(?<value>\d{1,2}\.\d{1,2}\.\d{4})\s+Saldo$`,
        to: String.raw`^(?<value>\d{1,2}\.\d{1,2}\.\d{4})\s+Saldo$`,
        openingBalance: String.raw`^(?<value>[+\-]\d+,\d{2})\s+Saldo$`,
        closingBalance: String.raw`^(?<value>[+\-]\d+,\d{2})\s+Saldo$`,
        maturityDate: String.raw`^Eräpäivä\s*\n(?<value>\d{1,2}\.\d{1,2}\.\d{4})$`,
      },
      dateFormat: "d.m.yyyy",
      money: { decimal: ",", thousands: "", negative: "leading", twoColumn: false },
    };
    const twoLineDoc = [
      "28.8.2025 Saldo",
      "+0,00 Saldo",
      "1.9.2025 +5,00 PALKKA",
      "Eräpäivä",
      "1.2.2027",
      "30.9.2025 Saldo",
      "+5,00 Saldo",
    ].join("\n");

    const { statement, unclaimed } = runRecipe(twoLineDoc, twoLineRecipe);

    expect(statement.maturityDate).toBe("2027-02-01");
    expect(unclaimed).toEqual([]);
  });
});

/**
 * A statement printing a running balance in its last column, described by a
 * header pattern broad enough to match a transaction line as well. One row is
 * printed without a sign, so `recordStart` misses it -- and before the header
 * pass learned to ignore record lines, the opening balance was read off the
 * first transaction's running balance (`opening + row1`), which cancelled the
 * missing row exactly: rows short by one, problems none, unclaimed none,
 * verdict ok, and the recipe stored for every month after.
 */
const runningBalanceRecipe: BankRecipe = {
  kind: "bank",
  skip: ["^Tiliote$"],
  recordStart: String.raw`^(?<date>\d{1,2}\.\d{1,2}\.\d{4})\s+(?<amount>[+\-]\d[\d ]*,\d{2})\s+(?<label>[A-ZÄÖÅ]+)`,
  continuation: [],
  restField: null,
  header: {
    from: String.raw`^Saldo\s+(?<value>\d{1,2}\.\d{1,2}\.\d{4})\s`,
    to: String.raw`^Saldo\s+(?<value>\d{1,2}\.\d{1,2}\.\d{4})\s`,
    openingBalance: String.raw`^\d{1,2}\.\d{1,2}\.\d{4}\s.*\s(?<value>\d[\d ]*,\d{2})$`,
    closingBalance: String.raw`^\d{1,2}\.\d{1,2}\.\d{4}\s.*\s(?<value>\d[\d ]*,\d{2})$`,
  },
  dateFormat: "d.m.yyyy",
  money: { decimal: ",", thousands: " ", negative: "leading", twoColumn: false },
};

const runningBalanceDoc = [
  "Tiliote",
  "Saldo 1.8.2026 1 000,00",
  "1.8.2026 -100,00 KAUPPA 900,00",
  "2.8.2026 -50,00 KIOSKI 850,00",
  // Printed without a sign, so `recordStart` never opens a record for it.
  "3.8.2026 100,00 KAHVILA 750,00",
  "Saldo 31.8.2026 750,00",
].join("\n");

describe("runRecipe -- an over-broad header pattern", () => {
  test("does not read a balance off a line that opens a record", () => {
    const withoutTheHiddenRow = runningBalanceDoc
      .split("\n")
      .filter((line) => !line.includes("KAHVILA"))
      .join("\n");

    // Every remaining line matching the broad pattern is a transaction, so
    // there is no balance left to find -- refused, rather than read as the
    // first row's running balance (900,00).
    expect(() => runRecipe(withoutTheHiddenRow, runningBalanceRecipe)).toThrow(/saldo/i);
  });

  test("cannot hide a transaction behind a compensating opening balance", () => {
    const run = runRecipe(runningBalanceDoc, runningBalanceRecipe);

    expect(run.statement.rows).toHaveLength(2);
    expect(run.statement.openingBalance.minor).not.toBe(90_000n);
    expect(verifyRun(run).ok).toBe(false);
  });
});

describe("runRecipe -- what skip removed", () => {
  const cancellingRecipe: BankRecipe = { ...recipe, skip: [...recipe.skip, "SIIRTO"] };
  const cancellingDoc = [
    "Tiliote",
    "+1 000,00 Saldo 1.8.2026",
    "1.8.2026 −25,90 PKORTTIMAKSU",
    "K-MARKET ESIMERKKI",
    "2.8.2026 −250,00 SIIRTO",
    "3.8.2026 +250,00 SIIRTO",
    "+974,10 Saldo 31.8.2026",
  ].join("\n");

  test("reports the skipped lines, so a cancelling pair cannot pass unseen", () => {
    const run = runRecipe(cancellingDoc, cancellingRecipe);

    // The old checks are both satisfied: one row of three, nothing unclaimed,
    // and 1 000,00 − 25,90 is exactly the closing balance the statement prints.
    expect(run.statement.rows).toHaveLength(1);
    expect(run.unclaimed).toEqual([]);
    expect(run.skipped.map((entry) => entry.text)).toEqual([
      "Tiliote",
      "2.8.2026 −250,00 SIIRTO",
      "3.8.2026 +250,00 SIIRTO",
    ]);
    expect(verifyRun(run).ok).toBe(false);
  });

  test("does not report page furniture a header pattern already accounts for", () => {
    const run = runRecipe(doc, recipe);

    expect(run.skipped.map((entry) => entry.text)).toEqual(["Tiliote", "1 (2)"]);
  });
});

describe("runRecipe -- the time budget", () => {
  test("is checked while header patterns run, not only around them", () => {
    // No balance lines at all: without a budget check in the header pass this
    // reaches `buildStatementHeader` and complains about the missing balances.
    const noBalances = Array.from({ length: 150 }, (_, index) => `ROSKAA ${index}`).join("\n");

    expect(() => runRecipe(noBalances, recipe, -1)).toThrow(/kesti liian kauan/);
  });
});

describe("a layout whose amount sits below its date", () => {
  const recipe = parseRecipe({
    kind: "bank",
    skip: [String.raw`^(?:Statement period:|TRANSACTIONS|END BALANCE)(?=\s|$)`],
    recordStart: String.raw`^(?<date>\d{4}-\d{2}-\d{2})$`,
    continuation: [String.raw`^(?<amount>[+-] [\d,.]+) EUR`],
    restField: "counterparty",
    header: {
      from: String.raw`^Statement period: (?<value>\d{4}-\d{2}-\d{2})`,
      to: String.raw`^Statement period: \d{4}-\d{2}-\d{2} (?<value>\d{4}-\d{2}-\d{2})`,
      openingBalance: String.raw`^Initial balance: (?<value>[\d,.]+) EUR$`,
      closingBalance: String.raw`^END BALANCE (?<value>[\d,.]+) EUR$`,
    },
    dateFormat: "yyyy-mm-dd",
    money: { decimal: ".", thousands: ",", negative: "leading", twoColumn: false },
  });

  const doc = [
    "Statement period: 2026-08-01 2026-08-29",
    "Initial balance: 100.00 EUR",
    "TRANSACTIONS",
    "2026-08-08",
    "Kahvila",
    "- 2.50 EUR",
    "2026-08-09",
    "Palkka",
    "+ 500.00 EUR",
    "END BALANCE 597.50 EUR",
  ].join("\n");

  test("reads the amount from the continuation line", () => {
    const { statement } = runRecipe(doc, recipe);

    expect(statement.rows.map((row) => [row.date, row.amount, row.counterparty])).toEqual([
      ["2026-08-08", -250n, "Kahvila"],
      ["2026-08-09", 50_000n, "Palkka"],
    ]);
  });
});

describe("a header fact the recipe could not find", () => {
  const base = {
    kind: "bank" as const,
    skip: [],
    recordStart: String.raw`^(?<date>\d{4}-\d{2}-\d{2})\s+(?<amount>-?[\d.]+)$`,
    continuation: [],
    restField: null,
    dateFormat: "yyyy-mm-dd" as const,
    money: { decimal: ".", thousands: ",", negative: "leading", twoColumn: false },
  };
  const doc = ["Alku: 100.00", "2026-08-08 -2.50"].join("\n");

  test("names the period when it is the period that is missing", () => {
    const recipe = parseRecipe({
      ...base,
      header: {
        openingBalance: String.raw`^Alku: (?<value>[\d.]+)$`,
        closingBalance: String.raw`^Alku: (?<value>[\d.]+)$`,
      },
    });

    expect(() => runRecipe(doc, recipe)).toThrow(/jakson alku.*jakson loppu/i);
  });

  test("names the balances when it is the balances that are missing", () => {
    const recipe = parseRecipe({
      ...base,
      header: {
        from: String.raw`^Alku: (?<value>[\d.]+)$`,
        to: String.raw`^Alku: (?<value>[\d.]+)$`,
      },
    });

    expect(() => runRecipe(doc, recipe)).toThrow(/alkusaldo.*loppusaldo/i);
  });
});

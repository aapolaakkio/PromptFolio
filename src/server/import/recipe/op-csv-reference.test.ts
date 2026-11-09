import { readBytes } from "../../files.ts";
import { describe, expect, test } from "vitest";

import { runCsvRecipe } from "./csv-recipe.ts";
import { OP_BANK_CSV_RECIPE, OP_CREDIT_CSV_RECIPE } from "./op-csv-reference.ts";

const fixture = (): Promise<ArrayBuffer> =>
  readBytes(`${import.meta.dirname}/../fixtures/op-bank-sample.csv`);

// SAFETY: the body has the shape the route returns.
const bytesOf = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer;

const textOf = async (): Promise<string> => new TextDecoder().decode(await fixture());

describe("OP account export", () => {
  test("reads every row, spending included, with no problems", async () => {
    const { rows, problems } = runCsvRecipe(await fixture(), OP_BANK_CSV_RECIPE);
    expect(problems).toEqual([]);
    expect(rows).toHaveLength(5);
  });

  test("decides direction from the amount's sign, not the bank's label", async () => {
    const { rows } = runCsvRecipe(await fixture(), OP_BANK_CSV_RECIPE);
    const byLabel = new Map(rows.map((row) => [row.note.split(" — ")[0], row]));

    expect(byLabel.get("PKORTTIMAKSU")?.type).toBe("WITHDRAWAL");
    expect(byLabel.get("PALKKA")?.type).toBe("DEPOSIT");
    expect(byLabel.get("MAKSUPALVELU")?.type).toBe("WITHDRAWAL");
    expect(byLabel.get("TILISIIRTO")?.type).toBe("WITHDRAWAL");
  });

  test("names interest, which is money in that is also income", async () => {
    const { rows } = runCsvRecipe(await fixture(), OP_BANK_CSV_RECIPE);
    const interest = rows.find((row) => row.type === "INTEREST");

    expect(interest?.amount).toBe(1234n);
    expect(interest?.date).toBe("2025-12-31");
  });

  test("keeps amounts signed, in minor units, through the Finnish decimal comma", async () => {
    const { rows } = runCsvRecipe(await fixture(), OP_BANK_CSV_RECIPE);

    expect(rows[0]?.amount).toBe(-4215n);
    expect(rows[1]?.amount).toBe(275_000n);
  });

  test("carries the archive id, so a re-imported range is skipped not doubled", async () => {
    const { rows } = runCsvRecipe(await fixture(), OP_BANK_CSV_RECIPE);

    expect(rows[0]?.externalId).toBe("20250901593100000001");
    expect(new Set(rows.map((row) => row.externalId)).size).toBe(rows.length);
  });

  test("joins label, counterparty and message into one readable note", async () => {
    const { rows } = runCsvRecipe(await fixture(), OP_BANK_CSV_RECIPE);

    expect(rows[1]?.note).toBe("PALKKA — ESIMERKKI OYJ — PALKKA 09/2025");
    expect(rows[3]?.note).toBe("TALLETUSKORKO");
  });

  test("reports an unreadable row instead of dropping it", async () => {
    const broken = (await textOf()).replace('"2026-01-02";"2026-01-02"', '"2.1.2026";"2026-01-02"');

    const { rows, problems } = runCsvRecipe(bytesOf(broken), OP_BANK_CSV_RECIPE);
    expect(rows).toHaveLength(4);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toContain("2.1.2026");
  });

  test("passes a structurally broken line through as a problem", async () => {
    const broken = (await textOf()).replace('"PKORTTIMAKSU"', '"PKORTTIMAKSU"x');

    const { rows, problems } = runCsvRecipe(bytesOf(broken), OP_BANK_CSV_RECIPE);
    expect(rows).toHaveLength(4);
    expect(problems[0]?.message).toContain("closing quote");
  });

  test("reports a row whose amount is missing rather than importing a zero", async () => {
    const broken = (await textOf()).replace('"-42,15"', '""');

    const { rows, problems } = runCsvRecipe(bytesOf(broken), OP_BANK_CSV_RECIPE);
    expect(rows).toHaveLength(4);
    expect(problems).toHaveLength(1);
  });
});

const CARD_CSV = [
  '"Kirjauspäivä";"Arvopäivä";"Määrä";"Kurssi";"Selite";"Maksaja";"Saaja";"Arkistointitunnus"',
  '"2026-08-27";"2026-08-28";-23.82;"EUR";"ESIMERKKI ENERGIA";"MAKSAJA NIMI";"ESIMERKKI ENERGIA";"10000000000000000000001"',
  '"2026-06-25";"2026-06-26";456.11;"EUR";"Suoritus";"";"";"202601011AAA00000001"',
].join("\r\n");

describe("OP credit card log", () => {
  test("is not readable by the account export's recipe", () => {
    expect(runCsvRecipe(bytesOf(CARD_CSV), OP_BANK_CSV_RECIPE).missingHeaders).toContain(
      "Määrä EUROA",
    );
  });

  test("reads a purchase, decimal point and all", () => {
    const { rows, problems } = runCsvRecipe(bytesOf(CARD_CSV), OP_CREDIT_CSV_RECIPE);

    expect(problems).toEqual([]);
    const purchase = rows.find((row) => row.counterparty === "ESIMERKKI ENERGIA");
    expect(purchase?.amount).toBe(-2382n);
    expect(purchase?.type).toBe("WITHDRAWAL");
    expect(purchase?.note).toContain("ESIMERKKI ENERGIA");
  });

  test("reads a settlement as money arriving on the card", () => {
    const { rows } = runCsvRecipe(bytesOf(CARD_CSV), OP_CREDIT_CSV_RECIPE);
    const settlement = rows.find((row) => row.note === "Suoritus");

    expect(settlement?.amount).toBe(45611n);
    expect(settlement?.type).toBe("DEPOSIT");
  });

  test("keeps the archive id, so a re-imported period does not double a month", () => {
    const { rows } = runCsvRecipe(bytesOf(CARD_CSV), OP_CREDIT_CSV_RECIPE);
    expect(rows[0]?.externalId).toBe("10000000000000000000001");
  });
});

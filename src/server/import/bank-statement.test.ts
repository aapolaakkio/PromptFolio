import { readBytes } from "../files.ts";
import { describe, expect, test } from "vitest";

import { matchesBank, OP_BANK, parseBankStatement } from "./bank-statement.ts";

// The fixture is a synthetic OP export in the real format: semicolon-delimited,
// quoted, UTF-8 with a BOM absent, ISO dates, Finnish decimal comma, and OP's
// own column names. Verified against a real export of several hundred rows,
// which parsed with no problems and no duplicate archive ids.

const fixture = (): Promise<ArrayBuffer> =>
  readBytes(`${import.meta.dirname}/fixtures/op-bank-sample.csv`);

/**
 * SAFETY: `TextEncoder.encode` always returns a `Uint8Array` backed by a plain
 * `ArrayBuffer` (never a `SharedArrayBuffer`), which the DOM type union cannot
 * express. Used by every helper below that builds a file in memory.
 */
const bytesOf = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer;

const withoutColumn = async (header: string): Promise<ArrayBuffer> => {
  const text = new TextDecoder().decode(await fixture());
  return bytesOf(text.replace(`"${header}";`, "").replace(`;"${header}"`, ""));
};

describe("matchesBank", () => {
  test("recognises OP's own header", async () => {
    expect(matchesBank(await fixture(), OP_BANK)).toBe(true);
  });

  test("refuses a file missing a column it depends on", async () => {
    expect(matchesBank(await withoutColumn("Saaja/Maksaja"), OP_BANK)).toBe(false);
  });

  test("refuses something that is not a CSV at all", () => {
    const bytes = bytesOf("%PDF-1.4\n");
    expect(matchesBank(bytes, OP_BANK)).toBe(false);
  });

  test("refuses an empty file, which has no header to check", () => {
    const bytes = bytesOf("");
    expect(matchesBank(bytes, OP_BANK)).toBe(false);
  });

  test("refuses a header-only export rather than reading nothing as a match", async () => {
    const text = new TextDecoder().decode(await fixture());
    const headerOnly = `${text.split("\n")[0]}\n`;
    const bytes = bytesOf(headerOnly);
    expect(matchesBank(bytes, OP_BANK)).toBe(false);
  });
});

describe("parseBankStatement", () => {
  test("reads every row, spending included, with no problems", async () => {
    const { rows, problems } = parseBankStatement(await fixture(), OP_BANK);
    expect(problems).toEqual([]);
    expect(rows).toHaveLength(5);
  });

  test("decides direction from the amount's sign, not the bank's label", async () => {
    const { rows } = parseBankStatement(await fixture(), OP_BANK);
    const byLabel = new Map(rows.map((row) => [row.note.split(" — ")[0], row]));

    expect(byLabel.get("PKORTTIMAKSU")?.type).toBe("WITHDRAWAL");
    expect(byLabel.get("PALKKA")?.type).toBe("DEPOSIT");
    expect(byLabel.get("MAKSUPALVELU")?.type).toBe("WITHDRAWAL");
    // A transfer is both directions depending on the day; the label cannot say.
    expect(byLabel.get("TILISIIRTO")?.type).toBe("WITHDRAWAL");
  });

  test("names interest, which is money in that is also income", async () => {
    const { rows } = parseBankStatement(await fixture(), OP_BANK);
    const interest = rows.find((row) => row.type === "INTEREST");

    expect(interest?.amount).toBe(1234n);
    expect(interest?.date).toBe("2025-12-31");
  });

  test("keeps amounts signed, in minor units, through the Finnish decimal comma", async () => {
    const { rows } = parseBankStatement(await fixture(), OP_BANK);

    expect(rows[0]?.amount).toBe(-4215n);
    expect(rows[1]?.amount).toBe(275_000n);
  });

  test("carries the archive id, so a re-imported range is skipped not doubled", async () => {
    const { rows } = parseBankStatement(await fixture(), OP_BANK);

    expect(rows[0]?.externalId).toBe("20250901593100000001");
    expect(new Set(rows.map((row) => row.externalId)).size).toBe(rows.length);
  });

  test("joins label, counterparty and message into one readable note", async () => {
    const { rows } = parseBankStatement(await fixture(), OP_BANK);

    expect(rows[1]?.note).toBe("PALKKA — ESIMERKKI OYJ — PALKKA 09/2025");
    // An empty counterparty leaves no dangling separator.
    expect(rows[3]?.note).toBe("TALLETUSKORKO");
  });

  test("reports an unreadable row instead of dropping it", async () => {
    const text = new TextDecoder().decode(await fixture());
    const broken = text.replace('"2026-01-02";"2026-01-02"', '"2.1.2026";"2026-01-02"');
    const bytes = bytesOf(broken);

    const { rows, problems } = parseBankStatement(bytes, OP_BANK);
    expect(rows).toHaveLength(4);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.message).toContain("2.1.2026");
  });

  test("passes a structurally broken line through as a problem", async () => {
    const text = new TextDecoder().decode(await fixture());
    // Content after a closing quote, before the delimiter: the CSV layer itself
    // refuses this line, and its complaint must reach the same list.
    const broken = text.replace('"PKORTTIMAKSU"', '"PKORTTIMAKSU"x');
    const bytes = bytesOf(broken);

    const { rows, problems } = parseBankStatement(bytes, OP_BANK);
    expect(rows).toHaveLength(4);
    expect(problems[0]?.message).toContain("lainausmerkkien");
  });

  test("reports a row whose amount is missing rather than importing a zero", async () => {
    const text = new TextDecoder().decode(await fixture());
    const broken = text.replace('"-42,15"', '""');
    const bytes = bytesOf(broken);

    const { rows, problems } = parseBankStatement(bytes, OP_BANK);
    expect(rows).toHaveLength(4);
    expect(problems[0]?.message).toBe("Summa puuttuu");
  });
});

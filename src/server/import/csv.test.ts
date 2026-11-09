import { readBytes } from "../files.ts";
import { test, expect } from "vitest";
import { parseCsv } from "./csv.ts";
import { NORDNET } from "./fixtures/broker-mappings.ts";

const fixture = (name: string) => readBytes(`${import.meta.dirname}/fixtures/${name}`);

const nordnetBytes = (text: string): ArrayBuffer => {
  const withBom = `﻿${text}`;
  const bytes = new Uint8Array(withBom.length * 2);
  for (let i = 0; i < withBom.length; i++) {
    const code = withBom.charCodeAt(i);
    bytes[i * 2] = code & 0xff;
    bytes[i * 2 + 1] = (code >> 8) & 0xff;
  }
  return bytes.buffer;
};

const utf8Semicolon = { ...NORDNET, encoding: "utf-8" as const, delimiter: ";" };

test("parses the real-format Nordnet fixture into labelled rows", async () => {
  const { rows, headers } = parseCsv(await fixture("nordnet-sample.csv"), NORDNET);
  expect(headers).toContain("Tapahtumatyyppi");
  expect(headers).toHaveLength(30);
  expect(rows).toHaveLength(13);
  expect(rows[0]!.values["ISIN"]).toBe("IE0002Y8CX98");
  expect(rows[0]!.values["Summa"]).toBe("-68,00");
  expect(rows[0]!.line).toBe(2);
});

test("keeps every occurrence of a repeated header reachable positionally, not just the last", () => {
  const header = [
    "Id",
    "Tapahtumatyyppi",
    "ISIN",
    "Kokonaiskulut",
    "Valuutta",
    "Summa",
    "Valuutta",
    "Välityspalkkio",
    "Valuutta",
  ].join("\t");
  const row = ["1", "OSTO", "IE0002Y8CX98", "3,00", "EUR", "-68,00", "EUR", "0,50", "USD"].join(
    "\t",
  );
  const { rows } = parseCsv(nordnetBytes(`${header}\n${row}\n`), NORDNET);

  expect(rows[0]!.values["Valuutta"]).toBe("USD");
  expect(rows[0]!.cells[4]).toBe("EUR");
  expect(rows[0]!.cells[6]).toBe("EUR");
  expect(rows[0]!.cells[8]).toBe("USD");
});

test("handles quoted fields containing the delimiter", () => {
  const csv = 'A;B\n"Acme; Inc";5\n';
  const { rows } = parseCsv(new TextEncoder().encode(csv).buffer, utf8Semicolon);
  expect(rows[0]!.values["A"]).toBe("Acme; Inc");
  expect(rows[0]!.values["B"]).toBe("5");
});

test("skips blank trailing lines instead of emitting empty rows", () => {
  const csv = "A;B\n1;2\n\n\n";
  const { rows } = parseCsv(new TextEncoder().encode(csv).buffer, utf8Semicolon);
  expect(rows).toHaveLength(1);
});

test("reports a column-count mismatch as a problem without discarding the good rows", () => {
  const csv = "A;B;C\n1;2;3\n4;5\n6;7;8\n";
  const { rows, problems } = parseCsv(new TextEncoder().encode(csv).buffer, utf8Semicolon);
  expect(rows).toHaveLength(2);
  expect(rows[0]!.values["A"]).toBe("1");
  expect(rows[1]!.values["A"]).toBe("6");
  expect(problems).toHaveLength(1);
  expect(problems[0]!.line).toBe(3);
  expect(problems[0]!.raw).toBe("4;5");
  expect(problems[0]!.message).toMatch(/line 3/i);
});

test("still throws when the file has no usable header row", async () => {
  expect(() => parseCsv(new TextEncoder().encode("\n1;2;3\n").buffer, utf8Semicolon)).toThrow(
    /header row/i,
  );
  expect(() => parseCsv(new ArrayBuffer(0), utf8Semicolon)).toThrow(/header row/i);
});

test('treats a field of only "" as an empty string, not a missing value', () => {
  const csv = 'A;B\n"";5\n';
  const { rows } = parseCsv(new TextEncoder().encode(csv).buffer, utf8Semicolon);
  expect(rows[0]!.values["A"]).toBe("");
  expect(rows[0]!.values["B"]).toBe("5");
});

test("treats a quote mid-field as a literal character, not the start of quoting", () => {
  const csv = 'A;B\nab"cd;5\n';
  const { rows } = parseCsv(new TextEncoder().encode(csv).buffer, utf8Semicolon);
  expect(rows[0]!.values["A"]).toBe('ab"cd');
  expect(rows[0]!.values["B"]).toBe("5");
});

test("unescapes a doubled quote inside a quoted field to a single literal quote", () => {
  const csv = 'A;B\n"Say ""hi""";5\n';
  const { rows } = parseCsv(new TextEncoder().encode(csv).buffer, utf8Semicolon);
  expect(rows[0]!.values["A"]).toBe('Say "hi"');
  expect(rows[0]!.values["B"]).toBe("5");
});

test("reports an unterminated quoted field as a problem without discarding the good rows", () => {
  const csv = 'A;B\n1;2\n"unterminated;5\n6;7\n';
  const { rows, problems } = parseCsv(new TextEncoder().encode(csv).buffer, utf8Semicolon);
  expect(rows).toHaveLength(2);
  expect(rows[0]!.values["A"]).toBe("1");
  expect(rows[1]!.values["A"]).toBe("6");
  expect(problems).toHaveLength(1);
  expect(problems[0]!.line).toBe(3);
  expect(problems[0]!.raw).toBe('"unterminated;5');
  expect(problems[0]!.message).toMatch(/line 3/i);
});

test("reports text after a closing quote (before the delimiter) as a problem", () => {
  const csv = 'A;B\n1;2\n"abc"def;5\n6;7\n';
  const { rows, problems } = parseCsv(new TextEncoder().encode(csv).buffer, utf8Semicolon);
  expect(rows).toHaveLength(2);
  expect(rows[0]!.values["A"]).toBe("1");
  expect(rows[1]!.values["A"]).toBe("6");
  expect(problems).toHaveLength(1);
  expect(problems[0]!.line).toBe(3);
  expect(problems[0]!.raw).toBe('"abc"def;5');
  expect(problems[0]!.message).toMatch(/line 3/i);
});

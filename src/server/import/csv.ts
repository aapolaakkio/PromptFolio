import { BROKER_CONFIGS } from "./brokers";
import type { BrokerCsvConfig, RawRow } from "./types";

/**
 * Split one CSV line, honouring double-quoted fields.
 *
 * A `"` only opens quoting when it appears at the very start of a field
 * (i.e. nothing has been accumulated into that field yet). A `"` appearing
 * anywhere else in an unquoted field is treated as a literal character —
 * this matches how real-world CSV producers/consumers behave and avoids a
 * single stray quote silently swallowing the rest of the line, delimiters
 * and all. Inside a quoted field, `""` is the escape for a literal `"`,
 * and the closing `"` ends quoting. A field left open at end-of-line
 * (no closing `"`) is a malformed row, so this throws rather than silently
 * absorbing the remainder of the line into one field.
 */
const splitLine = (line: string, delimiter: string, lineNumber: number): string[] => {
  const out: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"' && field === "") {
      quoted = true;
    } else if (char === delimiter) {
      out.push(field);
      field = "";
    } else {
      field += char;
    }
  }
  if (quoted) {
    throw new Error(`CSV rivi ${lineNumber}: päättymätön lainausmerkki`);
  }
  out.push(field);
  return out.map((f) => f.trim());
};

export const parseCsv = (bytes: ArrayBuffer, config: BrokerCsvConfig) => {
  const text = new TextDecoder(config.encoding).decode(bytes).replace(/^﻿/, "");
  const lines = text.split(/\r?\n/);
  const headerLine = lines[0];
  if (headerLine === undefined || headerLine.trim() === "") {
    throw new Error("CSV-tiedostosta puuttuu otsikkorivi");
  }
  const headers = splitLine(headerLine, config.delimiter, 1);

  const rows: RawRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    const cells = splitLine(line, config.delimiter, i + 1);
    if (cells.length !== headers.length) {
      throw new Error(`CSV rivi ${i + 1}: ${cells.length} saraketta, odotettiin ${headers.length}`);
    }
    rows.push({
      line: i + 1,
      values: Object.fromEntries(headers.map((h, index) => [h, cells[index] ?? ""])),
    });
  }
  return { rows, headers };
};

export const detectBroker = (headers: readonly string[]): BrokerCsvConfig | null => {
  const present = new Set(headers);
  for (const config of BROKER_CONFIGS) {
    if (config.signature.every((h) => present.has(h))) return config;
  }
  return null;
};

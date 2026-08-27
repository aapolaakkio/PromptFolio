import { BROKER_CONFIGS } from "./brokers";
import type { BrokerCsvConfig, CsvProblem, RawRow } from "./types";

/**
 * Split one CSV line, honouring double-quoted fields.
 *
 * A `"` only opens quoting when it appears at the very start of a field
 * (i.e. nothing has been accumulated into that field yet). A `"` appearing
 * anywhere else in an unquoted field is treated as a literal character —
 * this matches how real-world CSV producers/consumers behave and avoids a
 * single stray quote silently swallowing the rest of the line, delimiters
 * and all. Inside a quoted field, `""` is the escape for a literal `"`,
 * and the closing `"` ends quoting.
 *
 * Two situations are malformed quoting and throw rather than producing a
 * silently-wrong field: a field left open at end-of-line (no closing `"`),
 * and non-delimiter content directly following a field's closing `"`
 * (e.g. `"abc"def`) — RFC 4180 allows nothing but the delimiter or
 * end-of-line right after a closing quote, and silently concatenating that
 * trailing text would drop the quote characters without any signal.
 * `parseCsv` catches these per-row and turns them into `problems` instead
 * of aborting the whole file; see its own comment for why.
 */
const splitLine = (line: string, delimiter: string, lineNumber: number): string[] => {
  const out: string[] = [];
  let field = "";
  let quoted = false;
  let quoteClosed = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
        quoteClosed = true;
      } else {
        field += char;
      }
    } else if (quoteClosed && char !== delimiter) {
      throw new Error(
        `CSV rivi ${lineNumber}: lainausmerkkien jälkeen ylimääräistä sisältöä ennen erotinta`,
      );
    } else if (char === '"' && field === "") {
      quoted = true;
    } else if (char === delimiter) {
      out.push(field);
      field = "";
      quoteClosed = false;
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

/**
 * Parse a broker's CSV export into labelled rows.
 *
 * A missing or empty header row makes the file genuinely unusable — there
 * is no column schema to hang any row's values on — so that still throws.
 * Everything past the header is best-effort: a structurally broken data
 * row (wrong column count, malformed quoting) is recorded in `problems`
 * with its 1-based line number, a message, and its raw text, and parsing
 * continues with the next line. One bad row must not discard every good
 * row already parsed — see the spec's import-review-screen behaviour.
 */
export const parseCsv = (bytes: ArrayBuffer, config: BrokerCsvConfig) => {
  const text = new TextDecoder(config.encoding).decode(bytes).replace(/^﻿/, "");
  const lines = text.split(/\r?\n/);
  const headerLine = lines[0];
  if (headerLine === undefined || headerLine.trim() === "") {
    throw new Error("CSV-tiedostosta puuttuu otsikkorivi");
  }
  const headers = splitLine(headerLine, config.delimiter, 1);

  const rows: RawRow[] = [];
  const problems: CsvProblem[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    const lineNumber = i + 1;

    let cells: string[];
    try {
      cells = splitLine(line, config.delimiter, lineNumber);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      problems.push({ line: lineNumber, message, raw: line });
      continue;
    }

    if (cells.length !== headers.length) {
      problems.push({
        line: lineNumber,
        message: `CSV rivi ${lineNumber}: ${cells.length} saraketta, odotettiin ${headers.length}`,
        raw: line,
      });
      continue;
    }

    rows.push({
      line: lineNumber,
      values: Object.fromEntries(headers.map((h, index) => [h, cells[index] ?? ""])),
      cells,
    });
  }
  return { rows, headers, problems };
};

export const detectBroker = (headers: readonly string[]): BrokerCsvConfig | null => {
  const present = new Set(headers);
  for (const config of BROKER_CONFIGS) {
    if (config.signature.every((h) => present.has(h))) return config;
  }
  return null;
};

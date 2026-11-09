import type { BrokerCsvConfig, CsvProblem, RawRow } from "./types.ts";

/** `"` opens quoting only at a field start, `""` inside quotes is literal; malformed quoting throws. */
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
        `CSV line ${lineNumber}: extra content after the closing quote, before the delimiter`,
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
    throw new Error(`CSV line ${lineNumber}: unterminated quote`);
  }
  out.push(field);
  return out.map((f) => f.trim());
};

type CsvDialect = Pick<BrokerCsvConfig, "encoding" | "delimiter">;

export const parseCsv = (bytes: ArrayBuffer, config: CsvDialect) => {
  const text = new TextDecoder(config.encoding).decode(bytes).replace(/^﻿/, "");
  const lines = text.split(/\r?\n/);
  const headerLine = lines[0];
  if (headerLine === undefined || headerLine.trim() === "") {
    throw new Error("The CSV file has no header row");
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
        message: `CSV line ${lineNumber}: ${cells.length} columns, expected ${headers.length}`,
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

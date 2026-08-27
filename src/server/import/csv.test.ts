import { test, expect } from "bun:test";
import { parseCsv, detectBroker } from "./csv";
import { NORDNET, OP } from "./brokers";

const fixture = (name: string) => Bun.file(`${import.meta.dir}/fixtures/${name}`).arrayBuffer();

test("parses the Nordnet fixture into labelled rows", async () => {
  const { rows, headers } = parseCsv(await fixture("nordnet-sample.csv"), NORDNET);
  expect(headers).toContain("Tapahtumatyyppi");
  expect(rows).toHaveLength(5);
  expect(rows[0]!.values["ISIN"]).toBe("FI0009000681");
  expect(rows[0]!.values["Summa"]).toBe("-418,00");
  expect(rows[0]!.line).toBe(2);
});

test("parses the OP fixture with its own delimiter and headers", async () => {
  const { rows } = parseCsv(await fixture("op-sample.csv"), OP);
  expect(rows).toHaveLength(3);
  expect(rows[0]!.values["Laji"]).toBe("Merkintä");
  expect(rows[0]!.values["Osuudet"]).toBe("12,3456");
});

test("detects the broker from the header row", async () => {
  const nordnet = parseCsv(await fixture("nordnet-sample.csv"), NORDNET);
  const op = parseCsv(await fixture("op-sample.csv"), OP);
  expect(detectBroker(nordnet.headers)?.broker).toBe("nordnet");
  expect(detectBroker(op.headers)?.broker).toBe("op");
  expect(detectBroker(["Date", "Amount"])).toBeNull();
});

test("handles quoted fields containing the delimiter", () => {
  const csv = 'A;B\n"Yhtiö; Oyj";5\n';
  const { rows } = parseCsv(new TextEncoder().encode(csv).buffer, NORDNET);
  expect(rows[0]!.values["A"]).toBe("Yhtiö; Oyj");
  expect(rows[0]!.values["B"]).toBe("5");
});

test("skips blank trailing lines instead of emitting empty rows", () => {
  const csv = "A;B\n1;2\n\n\n";
  const { rows } = parseCsv(new TextEncoder().encode(csv).buffer, NORDNET);
  expect(rows).toHaveLength(1);
});

test("reports a column-count mismatch as a problem without discarding the good rows", () => {
  const csv = "A;B;C\n1;2;3\n4;5\n6;7;8\n";
  const { rows, problems } = parseCsv(new TextEncoder().encode(csv).buffer, NORDNET);
  expect(rows).toHaveLength(2);
  expect(rows[0]!.values["A"]).toBe("1");
  expect(rows[1]!.values["A"]).toBe("6");
  expect(problems).toHaveLength(1);
  expect(problems[0]!.line).toBe(3);
  expect(problems[0]!.raw).toBe("4;5");
  expect(problems[0]!.message).toMatch(/rivi 3/i);
});

test("still throws when the file has no usable header row", () => {
  const csv = "\n1;2;3\n";
  expect(() => parseCsv(new TextEncoder().encode(csv).buffer, NORDNET)).toThrow(/otsikkorivi/i);
  expect(() => parseCsv(new ArrayBuffer(0), NORDNET)).toThrow(/otsikkorivi/i);
});

// --- Quoted-field edge cases (deliberate behaviour, see task report) ---

test('treats a field of only "" as an empty string, not a missing value', () => {
  const csv = 'A;B\n"";5\n';
  const { rows } = parseCsv(new TextEncoder().encode(csv).buffer, NORDNET);
  expect(rows[0]!.values["A"]).toBe("");
  expect(rows[0]!.values["B"]).toBe("5");
});

test("treats a quote mid-field as a literal character, not the start of quoting", () => {
  const csv = 'A;B\nab"cd;5\n';
  const { rows } = parseCsv(new TextEncoder().encode(csv).buffer, NORDNET);
  expect(rows[0]!.values["A"]).toBe('ab"cd');
  expect(rows[0]!.values["B"]).toBe("5");
});

test("unescapes a doubled quote inside a quoted field to a single literal quote", () => {
  const csv = 'A;B\n"Say ""hi""";5\n';
  const { rows } = parseCsv(new TextEncoder().encode(csv).buffer, NORDNET);
  expect(rows[0]!.values["A"]).toBe('Say "hi"');
  expect(rows[0]!.values["B"]).toBe("5");
});

test("reports an unterminated quoted field as a problem without discarding the good rows", () => {
  const csv = 'A;B\n1;2\n"unterminated;5\n6;7\n';
  const { rows, problems } = parseCsv(new TextEncoder().encode(csv).buffer, NORDNET);
  expect(rows).toHaveLength(2);
  expect(rows[0]!.values["A"]).toBe("1");
  expect(rows[1]!.values["A"]).toBe("6");
  expect(problems).toHaveLength(1);
  expect(problems[0]!.line).toBe(3);
  expect(problems[0]!.raw).toBe('"unterminated;5');
  expect(problems[0]!.message).toMatch(/rivi 3/i);
});

test("reports text after a closing quote (before the delimiter) as a problem", () => {
  const csv = 'A;B\n1;2\n"abc"def;5\n6;7\n';
  const { rows, problems } = parseCsv(new TextEncoder().encode(csv).buffer, NORDNET);
  expect(rows).toHaveLength(2);
  expect(rows[0]!.values["A"]).toBe("1");
  expect(rows[1]!.values["A"]).toBe("6");
  expect(problems).toHaveLength(1);
  expect(problems[0]!.line).toBe(3);
  expect(problems[0]!.raw).toBe('"abc"def;5');
  expect(problems[0]!.message).toMatch(/rivi 3/i);
});

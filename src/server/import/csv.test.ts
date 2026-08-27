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

test("rejects a row with the wrong number of columns rather than shifting values", () => {
  const csv = "A;B;C\n1;2\n";
  expect(() => parseCsv(new TextEncoder().encode(csv).buffer, NORDNET)).toThrow(/rivi 2/i);
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

test("rejects a row with an unterminated quoted field instead of swallowing the rest of the line", () => {
  const csv = 'A;B\n"unterminated;5\n';
  expect(() => parseCsv(new TextEncoder().encode(csv).buffer, NORDNET)).toThrow(/rivi 2/i);
});

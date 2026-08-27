import { test, expect } from "bun:test";
import { parseOpPaste } from "./op-paste";

const fixture = (name: string) => Bun.file(`${import.meta.dir}/fixtures/${name}`).text();

const HEADER = [
  "Laji",
  "Tapahtuma",
  "Tapahtuma-",
  "päivämäärä",
  "Määrä",
  "Kurssi",
  "Kulut / Korot /",
  "Verot",
  "Yhteensä",
  "Toiminnot",
].join("\n");

test("parses the real-format OP fixture: all four observed row shapes", async () => {
  const text = await fixture("op-web-paste-sample.txt");
  const { headers, rows, problems } = parseOpPaste(text);
  expect(headers).toEqual([
    "Laji",
    "Tapahtuma",
    "Tapahtumapäivämäärä",
    "Määrä",
    "Kurssi",
    "Kulut / Korot / Verot",
    "Yhteensä",
  ]);
  expect(problems).toEqual([]);
  expect(rows).toHaveLength(4);

  const [ostoWithFee, ostoNoFee, myynti, osinko] = rows;
  expect(ostoWithFee!.values["Tapahtuma"]).toBe("OSTO");
  expect(ostoWithFee!.values["Kulut / Korot / Verot"]).toBe("0,02   EUR");
  expect(ostoNoFee!.values["Tapahtuma"]).toBe("OSTO");
  expect(ostoNoFee!.values["Kulut / Korot / Verot"]).toBe(""); // the fee line is absent, not blank
  expect(myynti!.values["Tapahtuma"]).toBe("MYYNTI");
  expect(myynti!.values["Kulut / Korot / Verot"]).toBe("0,45   EUR");
  expect(osinko!.values["Tapahtuma"]).toBe("OSINKO");
  expect(osinko!.values["Kulut / Korot / Verot"]).toBe("");
});

test("Yhteensä is always the last currency-shaped value, never recomputed", async () => {
  // The real MYYNTI row this fixture is modelled on does not reconcile as
  // quantity × Kurssi − fee (OP's displayed Kurssi is rounded for display)
  // -- this fixture reproduces that same non-reconciling shape on purpose.
  // A parser that tried to derive or cross-check Yhteensä would reject it.
  const { rows } = parseOpPaste(await fixture("op-web-paste-sample.txt"));
  const myynti = rows[2]!;
  expect(myynti.values["Kurssi"]).toBe("3,10   EUR");
  expect(myynti.values["Yhteensä"]).toBe("44,55   EUR"); // 15 * 3.10 - 0.45 = 46.05, not this
});

test("throws when the header block doesn't match (not an OP paste at all)", () => {
  expect(() => parseOpPaste("Id\tKauppapäivä\nfoo\n")).toThrow(/otsikkoa/i);
  expect(() => parseOpPaste("")).toThrow(/otsikkoa/i);
});

test("a row block with no date-shaped line becomes a problem, not a guess", () => {
  const text = `${HEADER}\nOP-MAAILMA INDEKSI A\nOSTO\n1,0000   kpl\n100,00   EUR\n100,00   EUR\n`;
  const { rows, problems } = parseOpPaste(text);
  expect(rows).toHaveLength(0);
  expect(problems).toHaveLength(1);
  expect(problems[0]!.message).toMatch(/päivämäärän muotoinen rivi/);
});

test("a row block with the date as the very first line (no type before it) becomes a problem", () => {
  const text = `${HEADER}\n01.01.2025\n1,0000   kpl\n100,00   EUR\n100,00   EUR\n`;
  const { problems } = parseOpPaste(text);
  expect(problems).toHaveLength(1);
  expect(problems[0]!.message).toMatch(/tapahtumatyyppi/);
});

test("a row block with a type line but no name before it becomes a problem", () => {
  // The type line is present (satisfying "date as the very first line"'s
  // check above), but nothing precedes it -- there is no name at all.
  const text = `${HEADER}\nOSTO\n01.01.2025\n1,0000   kpl\n100,00   EUR\n100,00   EUR\n`;
  const { problems } = parseOpPaste(text);
  expect(problems).toHaveLength(1);
  expect(problems[0]!.message).toMatch(/arvopaperin nimi/);
});

test("a row block missing the kpl line after the date becomes a problem", () => {
  const text = `${HEADER}\nOP-MAAILMA INDEKSI A\nOSTO\n01.01.2025\n100,00   EUR\n100,00   EUR\n`;
  const { problems } = parseOpPaste(text);
  expect(problems).toHaveLength(1);
  expect(problems[0]!.message).toMatch(/määrä \(kpl\)/);
});

test("a kpl-suffixed line whose numeric part doesn't parse is not quantity-shaped either", () => {
  const text = `${HEADER}\nOP-MAAILMA INDEKSI A\nOSTO\n01.01.2025\nn/a   kpl\n100,00   EUR\n100,00   EUR\n`;
  const { problems } = parseOpPaste(text);
  expect(problems).toHaveLength(1);
  expect(problems[0]!.message).toMatch(/määrä \(kpl\)/);
});

test("a row block with an unexpected number of currency-shaped values becomes a problem", () => {
  // Only one currency-shaped value after Määrä -- neither 2 (no fee) nor 3 (fee).
  const text = `${HEADER}\nOP-MAAILMA INDEKSI A\nOSTO\n01.01.2025\n1,0000   kpl\n100,00   EUR\n`;
  const { problems } = parseOpPaste(text);
  expect(problems).toHaveLength(1);
  expect(problems[0]!.message).toMatch(/valuuttamuotoisia rivejä/);
});

test("a row block whose currency-shaped-looking value fails to parse becomes a problem", () => {
  const text = `${HEADER}\nOP-MAAILMA INDEKSI A\nOSTO\n01.01.2025\n1,0000   kpl\nn/a   EUR\n100,00   EUR\n`;
  const { problems } = parseOpPaste(text);
  expect(problems).toHaveLength(1);
  expect(problems[0]!.message).toMatch(/valuuttamuotoinen rivi/);
});

test("a row block with more than one date-shaped line becomes a problem (ambiguous anchor)", () => {
  const text = `${HEADER}\nOP-MAAILMA INDEKSI A\n01.01.2025\n02.01.2025\n1,0000   kpl\n100,00   EUR\n100,00   EUR\n`;
  const { problems } = parseOpPaste(text);
  expect(problems).toHaveLength(1);
  expect(problems[0]!.message).toMatch(/useampi kuin yksi/);
});

test("a wrapped instrument name (more than one line before the type) is joined, not rejected", () => {
  // Not observed in a real paste (flagged as unverified in op-paste.ts's
  // module comment), but the shape-anchored parse handles it if it occurs:
  // every line between the block's start and the type line is the name.
  const text = `${HEADER}\nSome Fund\nName Continuation\nOSTO\n01.01.2025\n1,0000   kpl\n100,00   EUR\n100,00   EUR\n`;
  const { rows, problems } = parseOpPaste(text);
  expect(problems).toEqual([]);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.values["Laji"]).toBe("Some Fund Name Continuation");
});

test("good and bad blocks in the same file: one becomes a row, the other a problem", () => {
  const good = "OP-MAAILMA INDEKSI A\nOSTO\n01.01.2025\n1,0000   kpl\n100,00   EUR\n100,00   EUR";
  const bad = "OP-MAAILMA INDEKSI A\nOSTO\n1,0000   kpl\n100,00   EUR\n100,00   EUR"; // no date
  const text = `${HEADER}\n${good}\n \n${bad}\n`;
  const { rows, problems } = parseOpPaste(text);
  expect(rows).toHaveLength(1);
  expect(problems).toHaveLength(1);
});

test("does not require a trailing separator after the final row", async () => {
  // Confirmed against a real paste: the last row has no separator line
  // after it (the file just ends).
  const text = `${HEADER}\nOP-MAAILMA INDEKSI A\nOSTO\n01.01.2025\n1,0000   kpl\n100,00   EUR\n100,00   EUR`;
  const { rows, problems } = parseOpPaste(text);
  expect(rows).toHaveLength(1);
  expect(problems).toEqual([]);
});

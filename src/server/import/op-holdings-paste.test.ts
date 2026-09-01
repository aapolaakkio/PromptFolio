import { expect, test } from "vitest";

import { parseOpWebHoldings } from "./op-holdings-paste.ts";

// OP's web holdings view pastes one value per line, in sections, with column
// labels that wrap across lines. Layout is the real one; names and figures are
// invented.
const header = [
  "Laji",
  "Omistus kpl",
  "Myytävissä kpl",
  "Hankinta-",
  "hinta EUR",
  "Hankinta-",
  "arvo yht. EUR",
  "Markkina-",
  "hinta EUR",
  "Markkina-",
  "arvo yht. EUR",
  "Muutos EUR",
  "Muutos %",
  "Toiminnot",
];

const row = (name: string, qty: string, cost: string, value: string): string[] => [
  name,
  qty,
  qty,
  "6,93",
  cost,
  "3,10",
  value,
  "-69,04",
  "-55,34",
];

test("reads a holding's quantity, cost and market value", () => {
  const { holdings, problems } = parseOpWebHoldings(
    ["Osakkeet", ...header, ...row("ESIMERKKI OYJ", "18", "124,77", "55,73")].join("\n"),
  );
  expect(problems).toEqual([]);
  expect(holdings).toEqual([
    { name: "ESIMERKKI OYJ", quantity: "18", costEur: "124.77", marketValueEur: "55.73" },
  ]);
});

// The view prints one table per instrument kind, each with its own header, and
// the section headings sit between them.
test("reads every section, and never mistakes a section heading for a holding", () => {
  const text = [
    "Osakkeet",
    ...header,
    ...row("ESIMERKKI OYJ", "18", "124,77", "55,73"),
    "Rahasto-osuudet",
    ...header,
    ...row("ESIMERKKI-AASIA INDEKSI A", "15,4552", "3 325,00", "4 517,25"),
    ...row("ESIMERKKI-MAAILMA INDEKSI A", "56,2492", "9 880,00", "13 441,87"),
  ].join("\n");

  const { holdings, problems } = parseOpWebHoldings(text);
  expect(problems).toEqual([]);
  expect(holdings.map((h) => h.name)).toEqual([
    "ESIMERKKI OYJ",
    "ESIMERKKI-AASIA INDEKSI A",
    "ESIMERKKI-MAAILMA INDEKSI A",
  ]);
  expect(holdings[2]!.quantity).toBe("56.2492");
  expect(holdings[2]!.marketValueEur).toBe("13441.87");
});

test("handles thousands spaces and explicit plus signs", () => {
  const { holdings } = parseOpWebHoldings(
    [
      "Rahasto-osuudet",
      ...header,
      "ESIMERKKI INDEKSI A",
      "15,4552",
      "15,4552",
      "215,14",
      "3 325,00",
      "292,28",
      "4 517,25",
      "+1 192,25",
      "+35,86",
    ].join("\n"),
  );
  expect(holdings[0]!.costEur).toBe("3325");
  expect(holdings[0]!.marketValueEur).toBe("4517.25");
});

test("a row with the wrong number of figures is reported, not absorbed", () => {
  const text = [
    "Osakkeet",
    ...header,
    "ESIMERKKI OYJ",
    "18",
    "18",
    "6,93",
    // Four figures short of a row: counting positions would silently file the
    // next holding's name as this one's market value.
    "Rahasto-osuudet",
    ...header,
    ...row("ESIMERKKI INDEKSI A", "10", "100,00", "110,00"),
  ].join("\n");

  const { holdings, problems } = parseOpWebHoldings(text);
  expect(problems).toHaveLength(1);
  expect(problems[0]!.message).toContain("8 lukua");
  expect(holdings.map((h) => h.name)).toEqual(["ESIMERKKI INDEKSI A"]);
});

test("text that is not OP's holdings view is refused", async () => {
  expect(() => parseOpWebHoldings("Kuitti\nKiitos\n12,34")).toThrow(/ei tunnistettu/);
});

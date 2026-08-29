import { expect, test } from "bun:test";

import { parseHoldingsPaste } from "./holdings-paste";

// The shape a broker's portfolio table copies as: a header row and one
// tab-separated row per holding. Values here are invented; the layout is the
// real one.
const HEADER =
  "Nimi\tValuutta\tMäärä\tKeskikurssi\t% tänään\tViimeisin\tLainoitusarvo, EUR\tArvo EUR\tKehitys\tTuotto, EUR";

const row = (name: string, currency: string, qty: string, value: string): string =>
  [name, currency, qty, "10,0000", "0", "11,00", "100,0", value, "1,00", "1,00"].join("\t");

test("reads name, quantity and market value from a pasted table", () => {
  const { holdings, problems } = parseHoldingsPaste(
    [HEADER, row("Esimerkki Indeksi", "EUR", "27,4431", "10072,715424")].join("\n"),
  );
  expect(problems).toEqual([]);
  expect(holdings).toEqual([
    {
      name: "Esimerkki Indeksi",
      quantity: "27.4431",
      // Rounded to cents: a broker's table shows more decimals than money has,
      // and keeping them would be false precision.
      marketValueEur: "10072.72",
      currency: "EUR",
    },
  ]);
});

test("keeps the holding's own currency, which need not be the account's", () => {
  const { holdings } = parseHoldingsPaste(
    [HEADER, row("Esimerkki Sverige", "SEK", "26,299", "2035,1633266")].join("\n"),
  );
  expect(holdings[0]!.currency).toBe("SEK");
  // The value column is already in euros, whatever the holding is quoted in.
  expect(holdings[0]!.marketValueEur).toBe("2035.16");
});

// Columns are found by heading, not position: a broker is free to reorder them,
// and a positional read would file a market value as a quantity in silence.
test("finds its columns by heading, whatever order they come in", () => {
  const text = ["Arvo EUR\tNimi\tMäärä", "527,24\tEsimerkki Defence\t28"].join("\n");
  const { holdings } = parseHoldingsPaste(text);
  expect(holdings[0]).toEqual({
    name: "Esimerkki Defence",
    quantity: "28",
    marketValueEur: "527.24",
    currency: "EUR",
  });
});

test("a row that cannot be read is reported, and the rest still import", () => {
  const text = [
    HEADER,
    row("Esimerkki A", "EUR", "28", "527,24"),
    row("Esimerkki B", "EUR", "ei-luku", "912,004"),
    row("Esimerkki C", "EUR", "7", "229,11"),
  ].join("\n");

  const { holdings, problems } = parseHoldingsPaste(text);
  // One bad row must not discard the two good ones, and it must not vanish
  // silently either -- a holding that disappeared without a word would read as
  // one the owner does not have.
  expect(holdings.map((h) => h.name)).toEqual(["Esimerkki A", "Esimerkki C"]);
  expect(problems).toHaveLength(1);
  expect(problems[0]!.line).toBe(3);
});

test("a row with no name is reported rather than imported unnamed", () => {
  const { holdings, problems } = parseHoldingsPaste(
    [HEADER, row("", "EUR", "1", "1,00")].join("\n"),
  );
  expect(holdings).toEqual([]);
  expect(problems[0]!.message).toContain("nimi");
});

test("refuses a paste whose header has no quantity column", () => {
  expect(() => parseHoldingsPaste(["Nimi\tArvo EUR", "Esimerkki\t10,00"].join("\n"))).toThrow(
    /puuttuu sarake/,
  );
});

test("refuses a paste that is only a header", () => {
  expect(() => parseHoldingsPaste(HEADER)).toThrow(/puuttuu otsikkorivi tai rivit/);
});

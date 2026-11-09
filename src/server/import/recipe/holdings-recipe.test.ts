import { describe, expect, test } from "vitest";

import { HoldingsRecipeSchema, runHoldingsRecipe } from "./holdings-recipe.ts";
import { OP_HOLDINGS_RECIPE, TABLE_HOLDINGS_RECIPE } from "./holdings-reference.ts";

const OP_HEADER = [
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

const opRow = (name: string, qty: string, cost: string, value: string): string[] => [
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

describe("OP's web holdings view", () => {
  test("the reference recipe is one the schema accepts", () => {
    expect(HoldingsRecipeSchema.safeParse(OP_HOLDINGS_RECIPE).success).toBe(true);
  });

  test("reads a holding's quantity, cost and market value", () => {
    const run = runHoldingsRecipe(
      ["Osakkeet", ...OP_HEADER, ...opRow("EXAMPLE OYJ", "18", "124,77", "55,73")].join("\n"),
      OP_HOLDINGS_RECIPE,
    );
    expect(run.problems).toEqual([]);
    expect(run.holdings).toEqual([
      {
        name: "EXAMPLE OYJ",
        isin: null,
        quantity: "18",
        marketValueEur: "55.73",
        costEur: "124.77",
        currency: "EUR",
      },
    ]);
  });

  test("reads every section, and never mistakes a section heading for a holding", () => {
    const text = [
      "Osakkeet",
      ...OP_HEADER,
      ...opRow("EXAMPLE OYJ", "18", "124,77", "55,73"),
      "Rahasto-osuudet",
      ...OP_HEADER,
      ...opRow("EXAMPLE-AASIA INDEKSI A", "15,4552", "3 325,00", "4 517,25"),
      ...opRow("EXAMPLE-MAAILMA INDEKSI A", "56,2492", "9 880,00", "13 441,87"),
    ].join("\n");

    const run = runHoldingsRecipe(text, OP_HOLDINGS_RECIPE);
    expect(run.problems).toEqual([]);
    expect(run.holdings.map((h) => h.name)).toEqual([
      "EXAMPLE OYJ",
      "EXAMPLE-AASIA INDEKSI A",
      "EXAMPLE-MAAILMA INDEKSI A",
    ]);
    expect(run.holdings[2]?.quantity).toBe("56.2492");
    expect(run.holdings[2]?.marketValueEur).toBe("13441.87");
  });

  test("handles thousands spaces and explicit plus signs", () => {
    const run = runHoldingsRecipe(
      [
        "Rahasto-osuudet",
        ...OP_HEADER,
        "EXAMPLE INDEKSI A",
        "15,4552",
        "15,4552",
        "215,14",
        "3 325,00",
        "292,28",
        "4 517,25",
        "+1 192,25",
        "+35,86",
      ].join("\n"),
      OP_HOLDINGS_RECIPE,
    );
    expect(run.holdings[0]?.costEur).toBe("3325.00");
    expect(run.holdings[0]?.marketValueEur).toBe("4517.25");
  });

  test("a row with the wrong number of figures is reported, not absorbed", () => {
    const text = [
      "Osakkeet",
      ...OP_HEADER,
      "EXAMPLE OYJ",
      "18",
      "18",
      "6,93",
      "Rahasto-osuudet",
      ...OP_HEADER,
      ...opRow("EXAMPLE INDEKSI A", "10", "100,00", "110,00"),
    ].join("\n");

    const run = runHoldingsRecipe(text, OP_HOLDINGS_RECIPE);
    expect(run.problems).toHaveLength(1);
    expect(run.holdings.map((h) => h.name)).toEqual(["EXAMPLE INDEKSI A"]);
  });
});

const HEADER =
  "Nimi\tValuutta\tMäärä\tKeskikurssi\t% tänään\tViimeisin\tLainoitusarvo, EUR\tArvo EUR\tKehitys\tTuotto, EUR";

const tableRow = (name: string, currency: string, qty: string, value: string): string =>
  [name, currency, qty, "10,0000", "0", "11,00", "100,0", value, "1,00", "1,00"].join("\t");

describe("a broker's pasted portfolio table", () => {
  test("reads name, quantity and market value, rounding the value to cents", () => {
    const run = runHoldingsRecipe(
      [HEADER, tableRow("Example Indeksi", "EUR", "27,4431", "10072,715424")].join("\n"),
      TABLE_HOLDINGS_RECIPE,
    );
    expect(run.problems).toEqual([]);
    expect(run.holdings).toEqual([
      {
        name: "Example Indeksi",
        isin: null,
        quantity: "27.4431",
        marketValueEur: "10072.72",
        costEur: "",
        currency: "EUR",
      },
    ]);
  });

  test("keeps the holding's own currency, which need not be the account's", () => {
    const run = runHoldingsRecipe(
      [HEADER, tableRow("Example Sverige", "SEK", "26,299", "2035,1633266")].join("\n"),
      TABLE_HOLDINGS_RECIPE,
    );
    expect(run.holdings[0]?.currency).toBe("SEK");
    expect(run.holdings[0]?.marketValueEur).toBe("2035.16");
  });

  test("finds its columns by heading, whatever order they come in", () => {
    const run = runHoldingsRecipe(
      ["Arvo EUR\tNimi\tMäärä", "527,24\tExample Defence\t28"].join("\n"),
      {
        ...TABLE_HOLDINGS_RECIPE,
        columns: TABLE_HOLDINGS_RECIPE.columns.filter((c) => c.field !== "currency"),
      },
    );
    expect(run.holdings[0]?.name).toBe("Example Defence");
    expect(run.holdings[0]?.quantity).toBe("28");
    expect(run.holdings[0]?.marketValueEur).toBe("527.24");
  });

  test("a row that cannot be read is reported, and the rest still import", () => {
    const run = runHoldingsRecipe(
      [
        HEADER,
        tableRow("Example A", "EUR", "28", "527,24"),
        tableRow("Example B", "EUR", "not-a-number", "912,004"),
        tableRow("Example C", "EUR", "7", "229,11"),
      ].join("\n"),
      TABLE_HOLDINGS_RECIPE,
    );
    expect(run.holdings.map((h) => h.name)).toEqual(["Example A", "Example C"]);
    expect(run.problems).toHaveLength(1);
    expect(run.problems[0]?.line).toBe(3);
  });

  test("a row with no name is reported rather than imported unnamed", () => {
    const run = runHoldingsRecipe(
      [HEADER, tableRow("", "EUR", "1", "1,00")].join("\n"),
      TABLE_HOLDINGS_RECIPE,
    );
    expect(run.holdings).toEqual([]);
    expect(run.problems[0]?.message).toContain("Name");
  });

  test("a header without a column the recipe names reads nothing, and says which", () => {
    const run = runHoldingsRecipe(
      ["Nimi\tArvo EUR", "Example\t10,00"].join("\n"),
      TABLE_HOLDINGS_RECIPE,
    );
    expect(run.holdings).toEqual([]);
    expect(run.problems[0]?.message).toContain("Määrä");
  });
});

describe("a statement's own date and total", () => {
  test("are read by their patterns around a table, and the total is in cents", () => {
    const run = runHoldingsRecipe(
      ["Omistukset 31.12.2025", HEADER, tableRow("A", "EUR", "1", "10,00"), "Yhteensä 10,00"].join(
        "\n",
      ),
      {
        ...TABLE_HOLDINGS_RECIPE,
        skip: [String.raw`^Omistukset `, String.raw`^Yhteensä `],
        asOf: String.raw`Omistukset (?<value>\S+)`,
        total: String.raw`^Yhteensä (?<value>.+)$`,
      },
    );
    expect(run.holdings).toHaveLength(1);
    expect(run.asOf).toBe("2025-12-31");
    expect(run.statedTotalEur).toBe("10.00");
  });
});

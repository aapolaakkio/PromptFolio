import type { HoldingsRecipe } from "./holdings-recipe.ts";

const FIGURE = String.raw`[+-]?[\d ]+(?:,\d+)?`;
const ANY = String.raw`[^\n]+`;

/**
 * OP's web holdings view as it copies: one value per line, one table per
 * instrument kind with a section title and a wrapped header above each, and
 * eight figures after every name. Quantity, cost and market value are the
 * first, fourth and sixth.
 */
export const OP_HOLDINGS_RECIPE: HoldingsRecipe = {
  kind: "holdings",
  layout: "record",
  delimiter: null,
  columns: [],
  skip: [
    String.raw`^(?:Laji|Omistus kpl|Myytävissä kpl|Hankinta-|hinta EUR|arvo yht\. EUR|Markkina-|Muutos EUR|Muutos %|Toiminnot)$`,
    String.raw`^(?:Osakkeet|Rahasto-osuudet|ETF:t|Joukkovelkakirjat|Muut)$`,
  ],
  recordStart: String.raw`^(?![+-]?[\d ]+(?:,\d+)?$).+$`,
  record:
    String.raw`(?<name>${ANY})\n(?<quantity>${FIGURE})\n${ANY}\n${ANY}\n(?<cost>${FIGURE})\n` +
    String.raw`${ANY}\n(?<marketValue>${FIGURE})\n${ANY}\n${ANY}`,
  asOf: null,
  total: null,
  dateFormat: "dd.mm.yyyy",
  money: { decimal: ",", thousands: " ", negative: "leading", twoColumn: false },
};

/**
 * A broker's portfolio table as it copies: a header row and one tab-separated
 * row per holding, the value column already in euros whatever the holding is
 * quoted in.
 */
export const TABLE_HOLDINGS_RECIPE: HoldingsRecipe = {
  kind: "holdings",
  layout: "table",
  delimiter: "\t",
  columns: [
    { field: "name", header: "Nimi" },
    { field: "currency", header: "Valuutta" },
    { field: "quantity", header: "Määrä" },
    { field: "marketValue", header: "Arvo EUR" },
  ],
  skip: [],
  recordStart: null,
  record: null,
  asOf: null,
  total: null,
  dateFormat: "dd.mm.yyyy",
  money: { decimal: ",", thousands: "", negative: "leading", twoColumn: false },
};

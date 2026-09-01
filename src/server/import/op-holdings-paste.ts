import { parseMoney, parseQuantity, EUR } from "../../core/money.ts";
import type { PasteProblem } from "./holdings-paste.ts";

/**
 * OP's web holdings view, copied as text.
 *
 * It pastes one value per line with no delimiter, in sections -- `Osakkeet`,
 * `Rahasto-osuudet`, and whatever else the owner holds -- each preceded by a
 * column header whose labels wrap across several lines (`Markkina-` then
 * `arvo yht. EUR`). Distinct from both the year-end PDF statement, which lists
 * acquisition lots, and from a broker CSV, which has real columns.
 *
 * Anchored on shape, not on line offsets: the header's own line count varies
 * with how the labels wrap, and the number of sections varies with what is
 * held. A row is a name followed by exactly the eight figures the table shows,
 * and anything else is reported rather than absorbed.
 */
type OpWebHolding = {
  readonly name: string;
  readonly quantity: string;
  readonly costEur: string;
  readonly marketValueEur: string;
};

export type OpWebHoldings = {
  readonly holdings: OpWebHolding[];
  readonly problems: PasteProblem[];
};

/** A figure as OP prints it: Finnish decimals, thousands spaces, an explicit sign. */
const FIGURE = /^[+-]?[\d\s]+,\d+$|^[+-]?\d+$/;
/** The label that ends every section's header block. */
const HEADER_END = "Toiminnot";
/** Labels that mark a header block, so a section heading is never read as a holding. */
const HEADER_MARKERS = ["Laji", "Omistus kpl", "Myytävissä kpl", "Toiminnot"];

/** Eight figures per row, in the order the table prints them. */
const QUANTITY_AT = 0;
const COST_AT = 3;
const MARKET_VALUE_AT = 5;
const FIGURES_PER_ROW = 8;

export const parseOpWebHoldings = (text: string): OpWebHoldings => {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");

  if (!lines.some((line) => HEADER_MARKERS.includes(line))) {
    throw new Error("Liitetystä tekstistä ei tunnistettu OP:n omistusnäkymää");
  }

  const holdings: OpWebHolding[] = [];
  const problems: PasteProblem[] = [];

  // Rows only exist after a header block; everything before the first one is a
  // section heading or a wrapped label.
  let started = false;
  for (let i = 0; i < lines.length;) {
    const line = lines[i]!;
    if (line === HEADER_END) {
      started = true;
      i++;
      continue;
    }
    if (!started || FIGURE.test(line)) {
      i++;
      continue;
    }

    // A name. The next lines are its figures, up to the next non-figure.
    const figures: string[] = [];
    let j = i + 1;
    while (j < lines.length && FIGURE.test(lines[j]!)) figures.push(lines[j++]!);

    if (figures.length === 0) {
      // A section heading (`Rahasto-osuudet`) or a wrapped label, not a holding.
      i = j;
      continue;
    }
    if (figures.length !== FIGURES_PER_ROW) {
      problems.push({
        line: i + 1,
        message: `Riviltä odotettiin ${FIGURES_PER_ROW} lukua, saatiin ${figures.length}`,
        raw: [line, ...figures].join(" | "),
      });
      i = j;
      continue;
    }

    try {
      holdings.push({
        name: line,
        quantity: decimal(figures[QUANTITY_AT]!, "quantity"),
        costEur: decimal(figures[COST_AT]!, "money"),
        marketValueEur: decimal(figures[MARKET_VALUE_AT]!, "money"),
      });
    } catch (cause) {
      problems.push({
        line: i + 1,
        message: cause instanceof Error ? cause.message : "Rivin lukeminen epäonnistui",
        raw: [line, ...figures].join(" | "),
      });
    }
    i = j;
  }

  if (holdings.length === 0 && problems.length === 0) {
    throw new Error("Liitetystä tekstistä ei löytynyt omistuksia");
  }
  return { holdings, problems };
};

/** Validated through the project's own parsers, so a bad figure fails at the boundary. */
const decimal = (text: string, kind: "money" | "quantity"): string => {
  const cleaned = text.replace(/\s/g, "").replace(/^\+/, "");
  if (kind === "quantity") return String(Number(parseQuantity(cleaned).scaled) / 1e6);
  return String(Number(parseMoney(cleaned, EUR).minor) / 100);
};

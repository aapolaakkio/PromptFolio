import { parseMoney, parseQuantity, EUR } from "../../core/money";
import type { IsoDate } from "../../core/types";
import { extractPdfTextRuns } from "./pdf-text";

/**
 * One fund's line in OP's year-end holdings statement.
 *
 * `marketValue` is the broker's own figure, never derived from quantity times a
 * unit value: OP's printed unit value is rounded for display (§10a A3 recorded
 * the same thing about its web view), so recomputing it disagrees with the
 * statement by a few cents and the statement is the authority.
 */
export type OpHolding = {
  readonly name: string;
  readonly quantity: string;
  readonly costEur: string;
  readonly marketValueEur: string;
};

export type OpHoldingsStatement = {
  readonly asOf: IsoDate;
  readonly holdings: OpHolding[];
};

/** A fund's own heading; OP suffixes every one of them with its unit type. */
const FUND_HEADING = /^(.+?)\s*-?OSUUDET$/;
/** The per-fund total line, which is what a snapshot is built from. */
const TOTAL_LINE = /^Omistukset (\d{2})\.(\d{2})\.(\d{4})$/;
const NUMBER = /^-?[\d\s]+,\d+$/;

/**
 * Parses OP's year-end holdings statement into the rows a snapshot is made of.
 *
 * Anchored on shape, not on line positions -- the same rule the OP web-paste
 * parser follows and for the same reason: a lot table has a variable number of
 * rows per fund (one per acquisition date), so counting lines from the heading
 * books one fund's totals against another. Each fund's heading is followed by
 * its lots and then a single `Omistukset <date>` line, whose next eight numbers
 * are the totals. Quantity is the first and market value the fourth; the third
 * is the acquisition cost including fees.
 *
 * Throws when the file has no text layer at all, rather than returning an empty
 * statement -- an empty result would read as "you held nothing", which is the
 * one answer a holdings statement can never mean.
 */
export const parseOpHoldings = (bytes: Uint8Array): OpHoldingsStatement => {
  const runs = extractPdfTextRuns(bytes).map((run) => run.trim());
  if (runs.length === 0) {
    throw new Error("PDF:stä ei löytynyt tekstiä — se on todennäköisesti skannattu kuva");
  }

  const holdings: OpHolding[] = [];
  let asOf: IsoDate | null = null;
  let pendingName: string | null = null;

  for (let i = 0; i < runs.length; i++) {
    const run = runs[i]!;

    const heading = FUND_HEADING.exec(run);
    if (heading && heading[1] !== undefined && heading[1] !== "") {
      pendingName = heading[1].replace(/\s+A$/, " A").trim();
      continue;
    }

    const total = TOTAL_LINE.exec(run);
    if (!total || pendingName === null) continue;

    asOf = `${total[3]}-${total[2]}-${total[1]}`;
    const numbers = runs.slice(i + 1, i + 9).filter((value) => NUMBER.test(value));
    if (numbers.length < 4) {
      pendingName = null;
      continue;
    }

    holdings.push({
      name: pendingName,
      // Parsed and reformatted rather than passed through: a value the money
      // and quantity parsers reject must fail here, at the boundary, not
      // several layers downstream inside a snapshot nobody looks at again.
      quantity: formatDecimal(numbers[0]!, "quantity"),
      costEur: formatDecimal(numbers[2]!, "money"),
      marketValueEur: formatDecimal(numbers[3]!, "money"),
    });
    pendingName = null;
  }

  if (asOf === null || holdings.length === 0) {
    throw new Error("PDF:stä ei tunnistettu OP:n omistusraporttia");
  }
  return { asOf, holdings };
};

/** Validates through the project's own parsers, then hands back a plain decimal string. */
const formatDecimal = (text: string, kind: "money" | "quantity"): string => {
  const cleaned = text.replace(/\s/g, "");
  if (kind === "quantity") return String(Number(parseQuantity(cleaned).scaled) / 1e6);
  return String(Number(parseMoney(cleaned, EUR).minor) / 100);
};

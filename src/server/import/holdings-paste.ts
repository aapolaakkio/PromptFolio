import { parseMoney, parseQuantity, EUR } from "../../core/money.ts";

/**
 * One row of a broker's on-screen holdings table, pasted in. Nordnet publishes no
 * holdings export but its table copies as tab-separated text -- a better source
 * than the year-end PDF: no fonts to decode, and the figures are current.
 */

/**
 * Decodes a holdings export. Nordnet writes UTF-16LE with a byte-order mark, which
 * read as UTF-8 yields a file of null bytes. Sniffed from the mark, so a broker
 * exporting plain UTF-8 needs no special case.
 */
export const decodeHoldingsFile = (bytes: Uint8Array): string => {
  const utf16le = bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe;
  const utf16be = bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff;
  const encoding = utf16le ? "utf-16le" : utf16be ? "utf-16be" : "utf-8";
  return new TextDecoder(encoding).decode(bytes).replace(/^\ufeff/, "");
};

type PastedHolding = {
  readonly name: string;
  readonly quantity: string;
  readonly marketValueEur: string;
  readonly currency: string;
};

/**
 * Column headings this understands, mapped to the field they carry. Matched by
 * name rather than by position: a broker is free to reorder its columns, and a
 * positional read would then file a market value as a quantity without
 * complaining -- the exact failure the duplicate-`Valuutta` bug taught this
 * project to design against (§10a A2).
 */
const HEADINGS = new Map<string, keyof PastedHolding>([
  ["nimi", "name"],
  ["arvopaperi", "name"],
  ["määrä", "quantity"],
  ["osuudet", "quantity"],
  ["kpl", "quantity"],
  ["valuutta", "currency"],
  ["arvo eur", "marketValueEur"],
  ["markkina-arvo", "marketValueEur"],
  ["markkina-arvo eur", "marketValueEur"],
]);

const normalise = (heading: string): string => heading.trim().toLowerCase().replace(/\s+/g, " ");

export type PasteProblem = {
  readonly line: number;
  readonly message: string;
  readonly raw: string;
};

export type PastedHoldings = {
  readonly holdings: PastedHolding[];
  readonly problems: PasteProblem[];
};

/**
 * Parses a pasted holdings table. An unreadable row becomes a problem carrying its
 * own text, never an exception and never a silent skip: a holding that vanished
 * without a word would read as one the user does not own.
 */
export const parseHoldingsPaste = (text: string): PastedHoldings => {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length < 2) {
    throw new Error("Liitetystä taulukosta puuttuu otsikkorivi tai rivit");
  }

  const headings = lines[0]!.split("\t").map(normalise);
  const columnOf = (field: keyof PastedHolding): number =>
    headings.findIndex((heading) => HEADINGS.get(heading) === field);

  const nameAt = columnOf("name");
  const quantityAt = columnOf("quantity");
  const valueAt = columnOf("marketValueEur");
  if (nameAt < 0 || quantityAt < 0 || valueAt < 0) {
    throw new Error(
      "Otsikkoriviltä puuttuu sarake: tarvitaan nimi, määrä ja arvo (esim. Nimi, Määrä, Arvo EUR)",
    );
  }
  const currencyAt = columnOf("currency");

  const holdings: PastedHolding[] = [];
  const problems: PasteProblem[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    const cells = line.split("\t").map((cell) => cell.trim());
    const name = cells[nameAt] ?? "";
    if (name === "") {
      problems.push({ line: i + 1, message: "Riviltä puuttuu arvopaperin nimi", raw: line });
      continue;
    }

    try {
      holdings.push({
        name,
        quantity: formatQuantity(cells[quantityAt] ?? ""),
        // Rounded to cents on the way in. A broker's table shows a market value
        // to more decimals than money has; keeping them would be false
        // precision, and a snapshot's job is to be compared against the ledger,
        // not to out-resolve it.
        marketValueEur: formatMoney(cells[valueAt] ?? ""),
        currency: (cells[currencyAt] ?? "EUR").toUpperCase() || "EUR",
      });
    } catch (cause) {
      problems.push({
        line: i + 1,
        message: cause instanceof Error ? cause.message : "Rivin lukeminen epäonnistui",
        raw: line,
      });
    }
  }

  return { holdings, problems };
};

/** Validates through the project's own parser, then returns a plain decimal string. */
const formatQuantity = (text: string): string => {
  const cleaned = text.replace(/\s/g, "");
  if (cleaned === "") throw new Error("Määrä puuttuu");
  return String(Number(parseQuantity(cleaned).scaled) / 1e6);
};

const formatMoney = (text: string): string => {
  const cleaned = text.replace(/\s/g, "").replace(",", ".");
  if (cleaned === "") throw new Error("Arvo puuttuu");
  const rounded = Math.round(Number(cleaned) * 100);
  if (!Number.isFinite(rounded)) throw new Error(`Arvo ei kelpaa: ${text}`);
  // Round-tripped through parseMoney so an absurd value is rejected here rather
  // than several layers downstream.
  return String(Number(parseMoney((rounded / 100).toFixed(2), EUR).minor) / 100);
};

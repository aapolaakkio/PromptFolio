import { parseMoney, parseQuantity } from "../../core/money";
import type { BrokerCsvConfig, CanonicalField, CsvProblem, RawRow } from "./types";

export type DraftTxn = {
  readonly line: number;
  readonly accountId: number;
  readonly instrumentId: number | null;
  readonly isin: string | null;
  readonly type: string;
  readonly tradeDate: string;
  readonly quantity: number;
  readonly unitPrice: number | null;
  readonly amount: number;
  readonly fee: number;
  readonly tax: number;
  readonly currency: "EUR" | "USD";
  readonly fxRateEur: number;
  readonly externalId: string | null;
};

/**
 * A problem the user needs to see and act on, from either layer of import
 * parsing. `raw` holds parsed fields (empty for a structural failure that
 * never made it to fields); `rawLine` holds the unparsed line text and is
 * present only for that structural case. A consumer renders `rawLine` when
 * present and `raw`'s entries otherwise -- no runtime type narrowing needed,
 * which the vendored anti-slop/no-runtime-typeof rule would otherwise bar.
 */
export type DraftProblem = {
  readonly line: number;
  readonly message: string;
  readonly raw: Record<string, string>;
  readonly rawLine?: string;
};

export type Draft = {
  readonly txns: DraftTxn[];
  readonly problems: DraftProblem[];
  readonly unknownIsins: Array<{ isin: string; name: string }>;
};

/**
 * Normalises an ISO (`yyyy-mm-dd`) or Finnish (`dd.mm.yyyy`) date string to
 * ISO. Rejects malformed input and dates that don't exist (e.g. 32.01) by
 * round-tripping through `Date` and requiring the result to match exactly --
 * `Date` itself rolls a non-existent day into the next month rather than
 * rejecting it, so the round-trip is what catches that case.
 */
export const normaliseDate = (value: string, format: "iso" | "fi"): string => {
  const trimmed = value.trim();
  const match =
    format === "iso"
      ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed)
      : /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(trimmed);
  if (!match) throw new Error(`Päivämäärä ei kelpaa: ${JSON.stringify(value)}`);
  const [year, month, day] =
    format === "iso" ? [match[1]!, match[2]!, match[3]!] : [match[3]!, match[2]!, match[1]!];
  const iso = `${year}-${month}-${day}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso) {
    throw new Error(`Päivämäärää ei ole olemassa: ${JSON.stringify(value)}`);
  }
  return iso;
};

/** Stable per material field, independent of source line, so a re-import of the same file dedupes. */
export const contentHash = (txn: DraftTxn): string => {
  const material = [
    txn.accountId,
    txn.type,
    txn.tradeDate,
    txn.isin ?? "",
    txn.quantity,
    txn.amount,
    txn.fee,
    txn.currency,
  ].join("|");
  return new Bun.CryptoHasher("sha256").update(material).digest("hex");
};

/** Turns a structural CsvProblem (unparsed line) into the shared DraftProblem shape. */
const fromCsvProblem = (problem: CsvProblem): DraftProblem => ({
  line: problem.line,
  message: problem.message,
  raw: {},
  rawLine: problem.raw,
});

/**
 * Maps parsed CSV rows into draft transactions ready for the review screen.
 * A row that cannot be mapped becomes a `DraftProblem`, never an exception
 * and never a silent skip -- the user decides what to do with it. An ISIN
 * this caller hasn't seen before is never turned into an invented
 * instrument: it's collected in `unknownIsins` and the transaction gets
 * `instrumentId: null`.
 *
 * `csvProblems` carries Task 10's structural failures (bad column count,
 * malformed quoting) so the review screen gets one merged, line-ordered
 * list of everything wrong with the file instead of two separate ones.
 */
export const mapRows = (
  rows: readonly RawRow[],
  config: BrokerCsvConfig,
  knownIsins: ReadonlyMap<string, number>,
  csvProblems: readonly CsvProblem[] = [],
  accountId = 0,
): Draft => {
  const txns: DraftTxn[] = [];
  const problems: DraftProblem[] = [];
  const unknown = new Map<string, string>();

  const cell = (row: RawRow, field: CanonicalField): string => {
    const header = config.columns[field];
    return header ? (row.values[header] ?? "") : "";
  };

  for (const row of rows) {
    try {
      const label = cell(row, "type").trim().toLowerCase();
      const type = config.typeMap[label];
      if (!type) throw new Error(`Tuntematon tapahtumatyyppi: ${cell(row, "type")}`);

      const currencyText = cell(row, "currency").trim().toUpperCase() || "EUR";
      if (currencyText !== "EUR" && currencyText !== "USD") {
        throw new Error(`Tuettamaton valuutta: ${currencyText}`);
      }
      const currency = currencyText;

      const isinText = cell(row, "isin").trim();
      const isin = isinText === "" ? null : isinText;
      const instrumentId = isin ? (knownIsins.get(isin) ?? null) : null;
      if (isin && instrumentId === null) {
        unknown.set(isin, cell(row, "instrumentName").trim());
      }

      const quantityText = cell(row, "quantity").trim();
      const priceText = cell(row, "unitPrice").trim();
      const feeText = cell(row, "fee").trim();

      txns.push({
        line: row.line,
        accountId,
        instrumentId,
        isin,
        type,
        tradeDate: normaliseDate(cell(row, "tradeDate"), config.dateFormat),
        quantity: quantityText === "" ? 0 : Number(parseQuantity(quantityText).scaled),
        unitPrice:
          priceText === "" || priceText === "0"
            ? null
            : Number(parseMoney(priceText, currency).minor),
        amount: Number(parseMoney(cell(row, "amount") || "0", currency).minor),
        fee: feeText === "" ? 0 : Number(parseMoney(feeText, currency).minor),
        tax: 0,
        currency,
        fxRateEur: currency === "EUR" ? 100_000_000 : 0, // marker; Task 12 resolves from fx_rates at commit
        externalId: cell(row, "externalId").trim() || null,
      });
    } catch (cause) {
      problems.push({
        line: row.line,
        message: cause instanceof Error ? cause.message : "Rivin käsittely epäonnistui",
        raw: row.values,
      });
    }
  }

  const merged = [...csvProblems.map(fromCsvProblem), ...problems].sort((a, b) => a.line - b.line);

  return {
    txns,
    problems: merged,
    unknownIsins: [...unknown].map(([isin, name]) => ({ isin, name })),
  };
};

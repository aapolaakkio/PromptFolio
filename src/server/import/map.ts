import { createHash } from "node:crypto";
import { EUR, parseCurrency, parseMoney, parseQuantity, type Currency } from "../../core/money.ts";
import type { CanonicalField, CsvProblem, FieldMapping, RawRow } from "./types.ts";

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
  readonly currency: Currency;
  readonly fxRateEur: number;
  readonly externalId: string | null;
  /** The broker's own text for the row, when the export carries one. */
  readonly note: string | null;
};

/**
 * Something the user has to see and act on, from either layer of import parsing.
 * `rawLine` is present only for a structural failure that never reached fields;
 * a consumer renders it when present and `raw`'s entries otherwise.
 */
type DraftProblem = {
  readonly line: number;
  readonly message: string;
  readonly raw: Record<string, string>;
  readonly rawLine?: string;
};

export type Draft = {
  readonly txns: DraftTxn[];
  readonly problems: DraftProblem[];
  /**
   * Instruments this import could not resolve. `isin` is null for a broker whose
   * export carries no ISIN column at all, where resolution goes by name alone --
   * no ISIN is ever invented to fill the gap.
   */
  readonly unknownIsins: Array<{ isin: string | null; name: string; currency: Currency }>;
};

/**
 * An ISO or Finnish date string, as ISO. The round-trip through `Date` is what
 * catches a day that does not exist: `Date` rolls 32.01 into February rather
 * than refusing it.
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

/**
 * Stable per material field and independent of source line, so a re-import of the
 * same file dedupes. `line` is optional for a caller building a synthetic row.
 */
export const contentHash = (txn: Omit<DraftTxn, "line"> & { line?: number }): string => {
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
  return createHash("sha256").update(material).digest("hex");
};

/** Turns a structural CsvProblem (unparsed line) into the shared DraftProblem shape. */
const fromCsvProblem = (problem: CsvProblem): DraftProblem => ({
  line: problem.line,
  message: problem.message,
  raw: {},
  rawLine: problem.raw,
});

/** Named rather than trailing positionals, which are easy to mis-order. */
export type MapRowsOptions = {
  /** Task 10's structural failures (bad column count, malformed quoting), merged into `Draft.problems`. */
  readonly csvProblems?: readonly CsvProblem[];
  readonly accountId?: number;
  /**
   * Instrument name to id, matched case-insensitively, for a broker whose export
   * carries no ISIN. Without it a name-only row reads as unknown forever, even
   * right after the user resolves it on the review screen, because the rebuilt
   * draft has no way to know the instrument it just created is the same one.
   */
  readonly knownNames?: ReadonlyMap<string, number>;
};

/**
 * Parsed rows into draft transactions for the review screen.
 *
 * A row that cannot be mapped becomes a problem, never an exception and never a
 * silent skip -- the user decides. An unseen ISIN is never turned into an
 * invented instrument; it is collected instead, with a null instrument id.
 */
/** The canonical fields that ever hold a plain decimal, as opposed to a label or date. */
const NUMERIC_FIELDS: ReadonlySet<CanonicalField> = new Set([
  "quantity",
  "unitPrice",
  "fee",
  "amount",
]);

/** Drops a trailing "kpl"/"EUR" so the bare number reaches the parsers. */
const stripUnitSuffix = (text: string): string => text.replace(/\s*\p{L}+\.?\s*$/u, "").trim();

export const mapRows = (
  rows: readonly RawRow[],
  config: FieldMapping,
  knownIsins: ReadonlyMap<string, number>,
  options: MapRowsOptions = {},
): Draft => {
  const { csvProblems = [], accountId = 0, knownNames = new Map<string, number>() } = options;
  const txns: DraftTxn[] = [];
  const problems: DraftProblem[] = [];
  // First occurrence wins: a later row in another currency must not quietly
  // replace what the review screen was already going to show.
  const unknown = new Map<string, { isin: string | null; name: string; currency: Currency }>();
  // Uppercased once per call, so the lookup below is case-insensitive.
  const knownNamesUpper = new Map(
    [...knownNames].map(([name, id]) => [name.toUpperCase(), id] as const),
  );

  /**
   * A field's cell text. A position wins over a name, for a header that repeats.
   */
  const cell = (row: RawRow, field: CanonicalField): string => {
    const position = config.columnPositions?.[field];
    const raw =
      position !== undefined
        ? (row.cells[position - 1] ?? "")
        : (() => {
            const header = config.columns[field];
            return header ? (row.values[header] ?? "") : "";
          })();
    return config.stripUnitSuffixes && NUMERIC_FIELDS.has(field) ? stripUnitSuffix(raw) : raw;
  };

  /**
   * The row's cash flow. Nordnet's `Summa` is already signed; OP's total is not,
   * so a buy and a sell print identically and the sign comes from the type label.
   */
  const resolveAmount = (amountText: string, currency: Currency, label: string): bigint => {
    const parsed = parseMoney(amountText || "0", currency).minor;
    if (!config.amountSign) return parsed;
    const magnitude = parsed < 0n ? -parsed : parsed;
    const sign = config.amountSign[label] ?? 1;
    return BigInt(sign) * magnitude;
  };

  /**
   * A transfer-in moves no cash, so its `Summa` is zero -- but `buildLots` reads
   * an acquisition's cost from `-amount`, which would book the holding at zero
   * and report its whole value as gain. The acquisition value riding across is
   * used instead, negated to match the ledger's convention.
   */
  const acquisitionAmount = (
    row: RawRow,
    type: string,
    currency: Currency,
    label: string,
  ): bigint => {
    if (type !== "TRANSFER_IN") return resolveAmount(cell(row, "amount"), currency, label);
    const costText = cell(row, "costBasis").trim();
    if (costText === "") return resolveAmount(cell(row, "amount"), currency, label);
    const cost = parseMoney(costText, currency).minor;
    return cost > 0n ? -cost : cost;
  };

  for (const row of rows) {
    try {
      const label = cell(row, "type").trim().toLowerCase();
      const ignored = config.ignoredTypes?.[label];
      // The other leg carries this one. Reported rather than dropped: a row that
      // vanishes without trace looks exactly like one the parser missed.
      if (ignored !== undefined) {
        problems.push({
          line: row.line,
          message: `${cell(row, "type")}: ${ignored}`,
          raw: row.values,
        });
        continue;
      }
      const type = config.typeMap[label];
      if (!type) throw new Error(`Tuntematon tapahtumatyyppi: ${cell(row, "type")}`);

      // Any ISO 4217 code. A malformed one becomes a problem for this row
      // rather than a silent EUR default or a refusal of a real code like SEK.
      const currencyText = cell(row, "currency").trim().toUpperCase() || "EUR";
      const currency = parseCurrency(currencyText);
      /**
       * What the instrument is quoted in, not what the cash settled in. It picks
       * the listing the holding resolves to, so reading the settlement currency
       * for both put a US share on a European listing at the wrong exchange.
       */
      const priceCurrency = parseCurrency(
        cell(row, "priceCurrency").trim().toUpperCase() || currencyText,
      );

      const isinText = cell(row, "isin").trim();
      const isin = isinText === "" ? null : isinText;
      const nameText = cell(row, "instrumentName").trim();
      // By ISIN when there is one, by name otherwise -- case-insensitively,
      // since two pastes of the same holding need not agree on casing.
      const instrumentId = isin
        ? (knownIsins.get(isin) ?? null)
        : nameText !== ""
          ? (knownNamesUpper.get(nameText.toUpperCase()) ?? null)
          : null;
      if (isin && instrumentId === null) {
        if (!unknown.has(isin))
          unknown.set(isin, { isin, name: nameText, currency: priceCurrency });
      } else if (!isin && nameText !== "" && instrumentId === null) {
        // No ISIN to key on: resolved by name in the review flow, never
        // attached to a guess and never given an invented one.
        if (!unknown.has(nameText)) {
          unknown.set(nameText, { isin: null, name: nameText, currency: priceCurrency });
        }
      }

      const quantityText = cell(row, "quantity").trim();
      const priceText = cell(row, "unitPrice").trim();
      const feeText = cell(row, "fee").trim();
      // Parsed even for a dividend, so a malformed cell still surfaces, though
      // the stored quantity is forced to zero below: a dividend's count is
      // shares held, and left in place it would read as a trade.
      const quantityScaled = quantityText === "" ? 0n : parseQuantity(quantityText).scaled;

      txns.push({
        line: row.line,
        accountId,
        instrumentId,
        isin,
        type,
        tradeDate: normaliseDate(cell(row, "tradeDate"), config.dateFormat),
        quantity: type === "DIVIDEND" ? 0 : Number(quantityScaled),
        unitPrice:
          priceText === "" || priceText === "0"
            ? null
            : Number(parseMoney(priceText, priceCurrency).minor),
        amount: Number(acquisitionAmount(row, type, currency, label)),
        fee: feeText === "" ? 0 : Number(parseMoney(feeText, currency).minor),
        tax: 0,
        currency,
        fxRateEur: currency === EUR ? 100_000_000 : 0, // marker; Task 12 resolves from fx_rates at commit
        externalId: cell(row, "externalId").trim() || null,
        note: cell(row, "note").trim() || null,
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
    unknownIsins: [...unknown.values()],
  };
};

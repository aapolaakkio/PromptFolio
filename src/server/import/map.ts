import { createHash } from "node:crypto";
import { EUR, parseCurrency, parseMoney, parseQuantity, type Currency } from "../../core/money.ts";
import { assertReal } from "./recipe/date-format.ts";
import type { InstrumentKind } from "../instruments/openfigi.ts";
import type { Suggestion } from "./suggest-rows.ts";
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
  readonly note: string | null;
  readonly instrumentName?: string | undefined;
};

type DraftProblem = {
  readonly line: number;
  readonly message: string;
  readonly raw: Record<string, string>;
  readonly rawLine?: string;
  readonly ignored?: boolean;
  readonly suggestion?: Suggestion;
};

export type Draft = {
  readonly txns: DraftTxn[];
  readonly problems: DraftProblem[];
  readonly unknownIsins: Array<{ isin: string | null; name: string; currency: Currency }>;
  readonly added: AddedInstrument[];
};

export type AddedInstrument = {
  readonly isin: string;
  readonly name: string;
  readonly kind: InstrumentKind;
  readonly currency: string;
  readonly priceSource: "yahoo" | "page" | null;
  readonly sourceKey: string | null;
  readonly pending: boolean;
};

/** The Date round-trip catches days that do not exist. */
export const normaliseDate = (value: string, format: "iso" | "dmy"): string => {
  const trimmed = value.trim();
  const match =
    format === "iso"
      ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed)
      : /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(trimmed);
  if (!match) throw new Error(`Invalid date: ${JSON.stringify(value)}`);
  const [year, month, day] =
    format === "iso" ? [match[1]!, match[2]!, match[3]!] : [match[3]!, match[2]!, match[1]!];
  const iso = `${year}-${month}-${day}`;
  return assertReal(iso, value);
};

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

const fromCsvProblem = (problem: CsvProblem): DraftProblem => ({
  line: problem.line,
  message: problem.message,
  raw: {},
  rawLine: problem.raw,
});

type MapRowsOptions = {
  readonly csvProblems?: readonly CsvProblem[];
  readonly accountId?: number;
  readonly knownNames?: ReadonlyMap<string, number>;
};

const NUMERIC_FIELDS: ReadonlySet<CanonicalField> = new Set([
  "quantity",
  "unitPrice",
  "fee",
  "amount",
]);

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
  const unknown = new Map<string, { isin: string | null; name: string; currency: Currency }>();
  const knownNamesUpper = new Map(
    [...knownNames].map(([name, id]) => [name.toUpperCase(), id] as const),
  );

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

  const resolveAmount = (amountText: string, currency: Currency, label: string): bigint => {
    const parsed = parseMoney(amountText || "0", currency).minor;
    if (!config.amountSign) return parsed;
    const magnitude = parsed < 0n ? -parsed : parsed;
    const sign = config.amountSign[label] ?? 1;
    return BigInt(sign) * magnitude;
  };

  /** `buildLots` reads cost from `-amount`, so the acquisition value is negated. */
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
      if (ignored !== undefined) {
        problems.push({
          line: row.line,
          message: `${cell(row, "type")}: ${ignored}`,
          raw: row.values,
          ignored: true,
        });
        continue;
      }
      const type = config.typeMap[label];
      if (!type) throw new Error(`Unknown transaction type: ${cell(row, "type")}`);

      const currencyText = cell(row, "currency").trim().toUpperCase() || "EUR";
      const currency = parseCurrency(currencyText);
      const priceCurrency = parseCurrency(
        cell(row, "priceCurrency").trim().toUpperCase() || currencyText,
      );

      const isinText = cell(row, "isin").trim();
      const isin = isinText === "" ? null : isinText;
      const nameText = cell(row, "instrumentName").trim();
      const instrumentId = isin
        ? (knownIsins.get(isin) ?? null)
        : nameText !== ""
          ? (knownNamesUpper.get(nameText.toUpperCase()) ?? null)
          : null;
      if (isin && instrumentId === null) {
        if (!unknown.has(isin))
          unknown.set(isin, { isin, name: nameText, currency: priceCurrency });
      } else if (!isin && nameText !== "" && instrumentId === null) {
        if (!unknown.has(nameText)) {
          unknown.set(nameText, { isin: null, name: nameText, currency: priceCurrency });
        }
      }

      const quantityText = cell(row, "quantity").trim();
      const priceText = cell(row, "unitPrice").trim();
      const feeText = cell(row, "fee").trim();
      // Parsed even for a dividend so a malformed cell surfaces; stored as zero (it is shares held, not a trade).
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
        fxRateEur: currency === EUR ? 100_000_000 : 0, // marker: resolved from fx_rates at commit
        externalId: cell(row, "externalId").trim() || null,
        note: cell(row, "note").trim() || null,
        instrumentName: instrumentId === null && nameText !== "" ? nameText : undefined,
      });
    } catch (cause) {
      problems.push({
        line: row.line,
        message: cause instanceof Error ? cause.message : "Processing the row failed",
        raw: row.values,
      });
    }
  }

  const merged = [...csvProblems.map(fromCsvProblem), ...problems].sort((a, b) => a.line - b.line);

  return {
    txns,
    problems: merged,
    unknownIsins: [...unknown.values()],
    added: [],
  };
};

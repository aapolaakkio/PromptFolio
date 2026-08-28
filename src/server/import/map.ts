import { EUR, parseCurrency, parseMoney, parseQuantity, type Currency } from "../../core/money";
import type { CanonicalField, CsvProblem, FieldMapping, RawRow } from "./types";

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
  /**
   * Instruments this import couldn't resolve to a known `instrumentId`.
   * `isin` is set when the broker's export carries one (Nordnet); it is
   * `null` when the broker's export has none at all (OP's web-paste
   * transaction view carries no ISIN column) -- resolution then has to go
   * by `name` alone, and no ISIN is ever invented to fill the gap.
   */
  readonly unknownIsins: Array<{ isin: string | null; name: string; currency: Currency }>;
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

/**
 * Stable per material field, independent of source line, so a re-import of
 * the same file dedupes. `line` is optional on the input: a caller building
 * a synthetic row (e.g. Task 13's opening-balance import, which has no CSV
 * line to attach) can hash it before a line number exists.
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
 * Optional tail arguments for `mapRows`. A named options type -- not two
 * trailing positional optionals -- because two same-typed-enough optional
 * positionals (a number and an array) are easy to mis-order at a call site,
 * and TypeScript won't always catch it (it does here only because the
 * types happen to differ; it would not if both were arrays). This is a
 * declared record type, not the bare `object` keyword, so it isn't flagged
 * by `anti-slop/no-object-parameters`.
 */
export type MapRowsOptions = {
  /** Task 10's structural failures (bad column count, malformed quoting), merged into `Draft.problems`. */
  readonly csvProblems?: readonly CsvProblem[];
  readonly accountId?: number;
  /**
   * Instrument name -> known instrument id (any casing; matched
   * case-insensitively inside mapRows, so the caller need not normalise its
   * own keys), for a broker whose export carries no ISIN at all -- OP's
   * web-paste view (§10a A3). Nordnet rows always carry a real ISIN, so
   * `knownIsins` alone is enough for them to resolve to the same instrument
   * on every re-import once it's created once. An OP row has nothing to key
   * on but its name, and mapRows never retains a per-row name once
   * `unknownIsins` is built (`DraftTxn` has no `name` field), so without
   * this a name-only row would show up as "unknown" forever -- even
   * immediately after the user resolves it on the review screen and
   * previews again -- since the freshly rebuilt draft has no way to know
   * the instrument it just created is the same one. Task 20 (wiring the OP
   * paste route) is what populates this from the real `instruments` table;
   * it defaults to empty here so every existing caller that doesn't pass it
   * (map.test.ts's direct calls) keeps its prior name-always-unknown
   * behaviour exactly.
   */
  readonly knownNames?: ReadonlyMap<string, number>;
};

/**
 * Maps parsed CSV rows into draft transactions ready for the review screen.
 * A row that cannot be mapped becomes a `DraftProblem`, never an exception
 * and never a silent skip -- the user decides what to do with it. An ISIN
 * this caller hasn't seen before is never turned into an invented
 * instrument: it's collected in `unknownIsins` and the transaction gets
 * `instrumentId: null`.
 *
 * `options.csvProblems` carries Task 10's structural failures so the
 * review screen gets one merged, line-ordered list of everything wrong
 * with the file instead of two separate ones.
 */
/** The canonical fields that ever hold a plain decimal, as opposed to a label or date. */
const NUMERIC_FIELDS: ReadonlySet<CanonicalField> = new Set([
  "quantity",
  "unitPrice",
  "fee",
  "amount",
]);

/**
 * Strips a trailing unit label (e.g. "kpl", "EUR") that a broker's
 * web-paste export appends to an otherwise plain decimal cell, so the bare
 * number reaches `parseMoney`/`parseQuantity`. Only the trailing run of
 * letters (plus the whitespace separating it from the number) is removed;
 * a cell that is only a number is returned unchanged.
 */
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
  // First occurrence wins. The value now carries the row currency, so a
  // later row for the same holding in a different currency must not quietly
  // replace what the review screen was already going to show.
  const unknown = new Map<string, { isin: string | null; name: string; currency: Currency }>();
  // Normalised once per call, not per row: `knownNames`' own keys are
  // uppercased here so the lookup below is case-insensitive regardless of
  // how the caller cased them, without re-scanning the map on every row.
  const knownNamesUpper = new Map(
    [...knownNames].map(([name, id]) => [name.toUpperCase(), id] as const),
  );

  /**
   * A field's cell text. `columnPositions` (set for a header that repeats,
   * e.g. Nordnet's five `Valuutta` columns) takes priority and reads
   * `row.cells` by 1-based position; otherwise the field falls back to
   * `columns`' name lookup through `row.values`. `stripUnitSuffixes`
   * additionally strips a trailing unit label off a numeric field, for a
   * broker whose export renders "1,0453 kpl" rather than a bare number.
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
   * The cash-flow amount for one row. Nordnet's `Summa` already carries the
   * correct sign. OP's web-paste `YHTEENSÄ` is unsigned -- a 300 EUR buy
   * and a 300 EUR sell render identically -- so when `config.amountSign`
   * is set, the parsed magnitude is re-signed from the row's (lowercased)
   * type label instead of trusted as printed. A label with no entry in
   * `amountSign` defaults to a positive sign; that only happens for a
   * broker that opted into re-signing but left one of its own labels out,
   * a config gap rather than a data problem, so it is not raised here.
   */
  const resolveAmount = (amountText: string, currency: Currency, label: string): bigint => {
    const parsed = parseMoney(amountText || "0", currency).minor;
    if (!config.amountSign) return parsed;
    const magnitude = parsed < 0n ? -parsed : parsed;
    const sign = config.amountSign[label] ?? 1;
    return BigInt(sign) * magnitude;
  };

  /**
   * A TRANSFER_IN brings units in with no cash movement, so its `Summa` is
   * zero -- but `buildLots` reads an acquisition's cost from `-amount`, which
   * would give the new holding a cost basis of zero and report its whole value
   * as gain. The broker states the acquisition value riding across in its own
   * column instead; it is negated here to match the ledger's convention that an
   * acquisition's amount is the cash that left. Every other type keeps using
   * the row's own amount cell.
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
      // Understood and deliberately not imported -- the other leg of this event
      // already carries it. Reported rather than dropped in silence: a row that
      // vanishes with no trace is indistinguishable from one the parser missed.
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

      // Any ISO 4217 code is accepted here (§10a A1) -- `parseCurrency`
      // throws for anything not shaped like one (e.g. "GB", "EURO"), and
      // that throw is caught below like every other per-row failure,
      // turning it into a `DraftProblem` rather than a silent EUR default
      // or a rejection of a real, valid, non-EUR/USD code such as "SEK".
      const currencyText = cell(row, "currency").trim().toUpperCase() || "EUR";
      const currency = parseCurrency(currencyText);

      const isinText = cell(row, "isin").trim();
      const isin = isinText === "" ? null : isinText;
      const nameText = cell(row, "instrumentName").trim();
      // A row with a real ISIN resolves through `knownIsins` as before. A
      // row with none (OP) falls back to `knownNames`, matched
      // case-insensitively since the name the review screen sends back to
      // POST /api/instruments is the exact text this parser extracted, but
      // a *different* paste of the same holding is not guaranteed to carry
      // identical casing.
      const instrumentId = isin
        ? (knownIsins.get(isin) ?? null)
        : nameText !== ""
          ? (knownNamesUpper.get(nameText.toUpperCase()) ?? null)
          : null;
      if (isin && instrumentId === null) {
        if (!unknown.has(isin)) unknown.set(isin, { isin, name: nameText, currency });
      } else if (!isin && nameText !== "" && instrumentId === null) {
        // No ISIN to key on at all (OP's web-paste view). Resolution is
        // deferred to the review flow, by name, exactly like an unresolved
        // ISIN -- never silently attached to a guessed instrument, and
        // never given an invented ISIN.
        if (!unknown.has(nameText)) unknown.set(nameText, { isin: null, name: nameText, currency });
      }

      const quantityText = cell(row, "quantity").trim();
      const priceText = cell(row, "unitPrice").trim();
      const feeText = cell(row, "fee").trim();
      // Still parsed (and so still validated -- a malformed cell surfaces
      // as a problem the same as any other row) even for DIVIDEND, whose
      // stored quantity is forced to 0 below regardless of what this
      // yields: a dividend's "Määrä"-shaped cell is shares *held*, not
      // units bought or sold, and core/ledger's positionsAt already treats
      // DIVIDEND as a non-unit-moving type -- but a raw parsed value sitting
      // in DraftTxn.quantity/transactions.quantity would still read as a
      // trade to any future consumer that doesn't know that convention.
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
            : Number(parseMoney(priceText, currency).minor),
        amount: Number(acquisitionAmount(row, type, currency, label)),
        fee: feeText === "" ? 0 : Number(parseMoney(feeText, currency).minor),
        tax: 0,
        currency,
        fxRateEur: currency === EUR ? 100_000_000 : 0, // marker; Task 12 resolves from fx_rates at commit
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
    unknownIsins: [...unknown.values()],
  };
};

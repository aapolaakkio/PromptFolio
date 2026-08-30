import { parseMoney, type Currency, EUR } from "../../core/money.ts";
import { parseCsv } from "./csv.ts";
import type { BrokerCsvConfig, RawRow } from "./types.ts";

/**
 * A bank statement's own shape, separate from `BrokerCsvConfig`'s securities
 * columns: there is no ISIN, no quantity and no instrument anywhere in one.
 * The CSV mechanics (encoding, delimiter, quoting, BOM) are shared, so this
 * borrows `BrokerCsvConfig`'s parsing half and names its own columns.
 */
export type BankStatementConfig = {
  /** Which bank's format this is, for error messages and detection. */
  readonly bank: string;
  readonly encoding: BrokerCsvConfig["encoding"];
  readonly delimiter: string;
  readonly currency: Currency;
  /** Header names, exactly as the bank writes them. */
  readonly columns: {
    readonly date: string;
    readonly amount: string;
    readonly label: string;
    readonly counterparty: string;
    readonly message?: string;
    readonly reference?: string;
    readonly externalId?: string;
  };
  /** Every header that must be present for a file to be this bank's. */
  readonly signature: readonly string[];
  /**
   * Labels the bank uses for interest paid into the account. Everything else is
   * classified by the amount's sign -- see `rowType`.
   */
  readonly interestLabels: readonly string[];
};

export type BankRow = {
  readonly line: number;
  readonly date: string;
  readonly type: "DEPOSIT" | "WITHDRAWAL" | "INTEREST";
  /** Minor units, already signed: negative for money leaving. */
  readonly amount: bigint;
  readonly counterparty: string;
  /** Counterparty and message joined, as the ledger's `note`. */
  readonly note: string;
  readonly externalId: string | null;
};

export type BankStatement = {
  readonly rows: BankRow[];
  readonly problems: Array<{ line: number; message: string }>;
};

/**
 * OP's transaction export: semicolon-delimited, UTF-8 with a BOM, ISO dates, a
 * Finnish decimal comma. Only the label is read, never the numeric code beside
 * it, which is OP's own undocumented numbering.
 *
 * The archive id is unique per transaction and so serves as the external id: an
 * overlapping re-import skips what is stored instead of doubling a year.
 */
export const OP_BANK: BankStatementConfig = {
  bank: "op",
  encoding: "utf-8",
  delimiter: ";",
  currency: EUR,
  columns: {
    date: "Kirjauspäivä",
    amount: "Määrä EUROA",
    label: "Selitys",
    counterparty: "Saaja/Maksaja",
    message: "Viesti",
    reference: "Viite",
    externalId: "Arkistointitunnus",
  },
  signature: ["Kirjauspäivä", "Määrä EUROA", "Laji", "Selitys", "Saaja/Maksaja"],
  interestLabels: ["TALLETUSKORKO", "KORKO"],
};

/**
 * OP's credit card log: the account statement's shape under different header
 * names, with a decimal point where that one uses a comma.
 *
 * `Kurssi` holds a currency code rather than a rate, which is OP's naming and not
 * a mistake here. A row in another currency is refused, never treated as euros.
 *
 * The card's own settlement rows are imported like any other: they are the credit
 * side of a payment debited elsewhere, and pairing the two is what stops a month
 * of purchases and the bill for them both counting as spending.
 */
export const OP_CREDIT: BankStatementConfig = {
  bank: "op",
  encoding: "utf-8",
  delimiter: ";",
  currency: EUR,
  columns: {
    date: "Kirjauspäivä",
    amount: "Määrä",
    label: "Selite",
    counterparty: "Saaja",
    externalId: "Arkistointitunnus",
  },
  // `Kurssi` and `Maksaja` are what tell this apart from the account statement,
  // which has neither.
  signature: ["Kirjauspäivä", "Arvopäivä", "Määrä", "Kurssi", "Selite", "Arkistointitunnus"],
  // None. A card charges interest, it never pays it: "Korko" on this statement
  // is money owed, and it arrives negative, which `rowType` already books as a
  // withdrawal. Listing it here would only matter if it could ever be
  // positive, and it cannot.
  interestLabels: [],
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `parseCsv`'s half of the config: encoding and delimiter, which a bank
 * statement shares with a broker export. Nothing else is passed, because
 * nothing else applies -- rows are read by header name from `RawRow.values`.
 */
const csvConfigOf = (
  config: BankStatementConfig,
): Pick<BrokerCsvConfig, "encoding" | "delimiter"> => ({
  encoding: config.encoding,
  delimiter: config.delimiter,
});

/**
 * What kind of movement a row is, decided by the amount's sign rather than the
 * bank's label -- the opposite of the securities importer, where a mis-typed row
 * would corrupt a position. Here only cash is at stake and every label means in
 * or out, so an unrecognised one still imports correctly. Only interest needs
 * naming, being money in that is also income.
 */
const rowType = (
  label: string,
  amount: bigint,
  interestLabels: readonly string[],
): BankRow["type"] => {
  if (amount > 0n && interestLabels.some((known) => label.toUpperCase().includes(known))) {
    return "INTEREST";
  }
  return amount < 0n ? "WITHDRAWAL" : "DEPOSIT";
};

/** Counterparty and message together, trimmed, without an empty separator. */
const noteOf = (parts: readonly string[]): string =>
  parts
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .join(" — ");

const cell = (row: RawRow, header: string | undefined): string =>
  header === undefined ? "" : (row.values[header] ?? "").trim();

/** True when this file's header carries every column the config names. */
export const matchesBank = (bytes: ArrayBuffer, config: BankStatementConfig): boolean => {
  try {
    const { rows } = parseCsv(bytes, csvConfigOf(config));
    const first = rows[0];
    if (!first) return false;
    return config.signature.every((header) => header in first.values);
  } catch {
    return false;
  }
};

/**
 * Reads a statement into cash movements. Every row is kept, spending included: a
 * statement's value is that it accounts for the balance, and a filtered import
 * matches nothing. Unreadable rows are reported rather than dropped.
 */
export const parseBankStatement = (
  bytes: ArrayBuffer,
  config: BankStatementConfig,
): BankStatement => {
  const { rows: raw, problems: csvProblems } = parseCsv(bytes, csvConfigOf(config));

  const rows: BankRow[] = [];
  const problems = csvProblems.map((problem) => ({
    line: problem.line,
    message: problem.message,
  }));

  for (const row of raw) {
    const date = cell(row, config.columns.date);
    const amountText = cell(row, config.columns.amount);
    try {
      if (!ISO_DATE.test(date)) throw new Error(`Päivämäärä ei ole muotoa YYYY-MM-DD: "${date}"`);
      if (amountText === "") throw new Error("Summa puuttuu");

      const amount = parseMoney(amountText, config.currency).minor;
      const label = cell(row, config.columns.label);
      const counterparty = cell(row, config.columns.counterparty);
      const externalId = cell(row, config.columns.externalId);

      rows.push({
        line: row.line,
        date,
        type: rowType(label, amount, config.interestLabels),
        amount,
        counterparty,
        // The label is kept in the note even when the counterparty is named:
        // "PKORTTIMAKSU" is how a card payment is distinguished from a transfer
        // to the same shop, and the spending view reads both.
        note: noteOf([label, counterparty, cell(row, config.columns.message)]),
        externalId: externalId === "" ? null : externalId,
      });
    } catch (cause) {
      problems.push({
        line: row.line,
        message: cause instanceof Error ? cause.message : "Rivin käsittely epäonnistui",
      });
    }
  }

  return { rows, problems };
};

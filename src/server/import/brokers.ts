import type { BrokerCsvConfig } from "./types";

/**
 * Derived from a real Nordnet transaction export (288 rows, 30 columns),
 * not a guess -- see docs/superpowers/specs/2026-08-27-portfolio-manager-design.md
 * §10a. The export is UTF-16LE with a BOM, tab-delimited, CRLF line
 * endings. Column *names* were already right in the earlier guessed
 * config; encoding and delimiter were not.
 *
 * The export has five columns named `Valuutta` (positions 13, 15, 17, 19,
 * 28). Position 13 is the transaction's own currency; position 28 is the
 * commission's currency. `columns.currency` is deliberately absent --
 * `columnPositions.currency: 13` addresses it positionally instead, so the
 * name-keyed (and therefore last-wins) `values` map is never consulted for
 * this field. See src/server/import/types.ts's `BrokerCsvConfig` comment.
 *
 * `typeMap` covers exactly the 13 transaction-type labels observed in the
 * real export; nothing here is a guess at a label Nordnet might also emit
 * (Swedish/English variants, "Osinko" for a dividend). A label outside
 * this set surfaces as a review problem instead of being silently
 * mis-booked -- see docs/superpowers/sdd/2026-08-27-promptfolio-phase-1/fix-real-fixtures-report.md
 * for the reasoning behind each mapping, including the two labels
 * (DESIM. ULOSKIRJ. KÄT, DESIM KIRJAUS OTTO) left unmapped on purpose.
 */
export const NORDNET: BrokerCsvConfig = {
  broker: "nordnet",
  encoding: "utf-16le",
  delimiter: "\t",
  dateFormat: "iso",
  columns: {
    externalId: "Id",
    tradeDate: "Kauppapäivä",
    type: "Tapahtumatyyppi",
    instrumentName: "Arvopaperi",
    isin: "ISIN",
    quantity: "Määrä",
    unitPrice: "Kurssi",
    fee: "Kokonaiskulut",
    amount: "Summa",
  },
  columnPositions: {
    currency: 13,
  },
  typeMap: {
    osto: "BUY",
    myynti: "SELL",
    talletus: "DEPOSIT",
    nosto: "WITHDRAWAL",
    "reaaliaikainen talle": "DEPOSIT",
    "etf_kk säästön palvelumaksu": "FEE",
    // Nordnet's own typo ("palvemaksu", not "palvelumaksu") -- matched
    // exactly, not corrected, since the export is what has to be parsed.
    "per etf-kk säästön palvemaksu": "FEE",
    "pääomit ylit.korko": "INTEREST",
    lainakorko: "INTEREST",
    // A same-day ISIN-to-ISIN conversion (an ETF/fund merger), paired: the
    // old ISIN's units are removed at zero cash cost (AP-OTTO, "taken
    // out"), the new ISIN's units are added at zero cash cost (AP-JÄTTÖ,
    // "left/deposited"). Modelled as a TRANSFER_OUT leg on the old
    // instrument and a TRANSFER_IN leg on the new one, mirroring the
    // existing "arvopaperisiirto sisään/ulos" TRANSFER_IN/OUT usage --
    // both types already move units with no cash effect.
    "vaihto ap-otto": "TRANSFER_OUT",
    "vaihto ap-jättö": "TRANSFER_IN",
    // "DESIM. ULOSKIRJ. KÄT" and "DESIM KIRJAUS OTTO" are deliberately
    // absent. Both are Nordnet's internal handling of one fractional-share
    // cash-out event (paired rows, same ISIN/quantity/price/amount) but
    // their `Kokonaismäärä` running-balance snapshots are inconsistent
    // between the two rows in the real export, and no combination of the
    // existing TransactionType values represents that without risking a
    // wrong quantity or double-counted cash. Left unmapped so each
    // instance surfaces as a review problem rather than being guessed.
  },
  signature: ["Tapahtumatyyppi", "ISIN", "Summa"],
};

/**
 * OP offers no CSV export. What existed here before (a `csv_op` config
 * describing a semicolon-delimited file) described a file that does not
 * exist -- see §10a A3. Transactions instead come from copying OP's web
 * transaction table and pasting it in, tab-separated, as a browser copy
 * produces it.
 *
 * Three things differ from a broker CSV and are handled here:
 *  - Dates are `dd.mm.yyyy` (`dateFormat: "fi"`).
 *  - Every numeric cell carries a trailing unit label ("1,0453 kpl",
 *    "286,99 EUR") -- `stripUnitSuffixes: true` strips it before parsing.
 *  - `YHTEENSÄ` (the total) is unsigned: a 300 EUR buy and a 300 EUR sell
 *    render identically. `amountSign` re-signs the parsed magnitude from
 *    the row's own OSTO/MYYNTI label instead of trusting the printed text.
 *
 * There is no ISIN column at all -- `columns` has no `isin` entry, so
 * every row resolves (or fails to resolve) by instrument name alone
 * through mapRows' unknown-instrument tracking. No ISIN is invented.
 *
 * Only OSTO and MYYNTI are mapped: those are the only labels the real OP
 * web view we inspected actually produced. A label outside this set (a
 * dividend payout, a deposit made through OP rather than a purchase)
 * surfaces as a review problem instead of being guessed at.
 */
export const OP_WEB_PASTE: BrokerCsvConfig = {
  broker: "op",
  encoding: "utf-8",
  delimiter: "\t",
  dateFormat: "fi",
  stripUnitSuffixes: true,
  columns: {
    instrumentName: "LAJI",
    type: "TAPAHTUMA",
    tradeDate: "TAPAHTUMAPÄIVÄMÄÄRÄ",
    quantity: "MÄÄRÄ",
    unitPrice: "KURSSI",
    fee: "KULUT / KOROT / VEROT",
    amount: "YHTEENSÄ",
  },
  typeMap: {
    osto: "BUY",
    myynti: "SELL",
  },
  amountSign: {
    osto: -1,
    myynti: 1,
  },
  signature: ["TAPAHTUMA", "TAPAHTUMAPÄIVÄMÄÄRÄ", "YHTEENSÄ"],
};

export const BROKER_CONFIGS: readonly BrokerCsvConfig[] = [NORDNET, OP_WEB_PASTE];

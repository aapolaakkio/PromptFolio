import type { BrokerCsvConfig, OpPasteConfig } from "./types";

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
 * `typeMap` covers exactly the transaction-type labels observed in real
 * exports; nothing here is a guess at a label Nordnet might also emit
 * (Swedish or English variants). A label outside this set surfaces as a
 * review problem instead of being silently mis-booked -- see
 * docs/superpowers/sdd/2026-08-27-promptfolio-phase-1/fix-real-fixtures-report.md
 * for the reasoning behind each mapping.
 *
 * A second, wider export (2026-08-28, covering a second Nordnet account
 * rather than one) added five labels: OSINKO, TALLETUS OST., NOSTO OST.
 * and PÄÄOMATULOVERO OST, all mapped below, and four more left unmapped
 * beside the original four.
 *
 * **Deliberately unmapped**, because each is one leg of a two-row event
 * whose other leg carries the same units or the same cash, so booking
 * either leg on its own would double a position or a cash balance:
 * DESIM. ULOSKIRJ. KÄT / DESIM KIRJAUS OTTO (a fractional-share cash-out),
 * VAIHTO AP-OTTO / VAIHTO AP-JÄTTÖ (a share swap), JÄTTÖ SIIRTO / AP OTTO
 * (a subscription commitment converting into shares, both legs at
 * `Summa: 0`), and LUNASTUS AP OTTO / LUNASTUS AP KÄT. (a tender offer:
 * one leg removes the shares, the other brings the cash, and both state
 * the full quantity and price). Each surfaces for manual review.
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
    costBasis: "Hankinta-arvo",
    fee: "Kokonaiskulut",
    amount: "Summa",
  },
  columnPositions: {
    currency: 13,
  },
  ignoredTypes: {
    "desim. uloskirj. kät":
      "Murto-osan lunastuksen käteispuoli; sama summa on jo DESIM KIRJAUS OTTO -rivillä.",
    "lunastus ap kät.": "Lunastuksen käteispuoli; sama summa on jo LUNASTUS AP OTTO -rivillä.",
    "ap otto":
      "Merkintäsitoumuksen poisto. Parinsa (JÄTTÖ SIIRTO) kanssa nettovaikutus on nolla eikä rivillä ole ISIN-tunnusta.",
    "jättö siirto":
      "Merkintäsitoumuksen kirjaus. Parinsa (AP OTTO) kanssa nettovaikutus on nolla eikä rivillä ole ISIN-tunnusta.",
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
    osinko: "DIVIDEND",
    // "OST." here is *osakesäästötili* (a Finnish equity savings account), not
    // "osto" -- these are that account's own cash legs, and every one observed
    // carries a "Internal from/to <other account number>" transaction text.
    "talletus ost.": "DEPOSIT",
    "nosto ost.": "WITHDRAWAL",
    // Capital income tax withheld on an equity-savings-account withdrawal. Booked
    // as FEE, not WITHDRAWAL: the money leaves the portfolio permanently but does
    // not reach the investor, and calling it a withdrawal would tell the
    // money-weighted return that it was money taken out and enjoyed. Phase 4's tax
    // reporting will want these rows specifically -- see the spec's 10c/C3.
    "pääomatulovero ost": "FEE",
    // Both legs of a share swap (an ETF merger, or shares converting into a
    // tender-offer line). The OTTO leg removes the old instrument's units; the
    // JÄTTÖ leg brings the new instrument's units in and is the only row that
    // states the acquisition value riding across (`Hankinta-arvo`), which is
    // why `columns.costBasis` exists. Both legs share a trade date, so the
    // portfolio's value does not jump on either side of the swap.
    "vaihto ap-otto": "TRANSFER_OUT",
    "vaihto ap-jättö": "TRANSFER_IN",
    // The units-and-cash leg of a fractional-share cash-out and of a tender
    // offer's settlement. Each states both the quantity disposed of and the
    // cash received in `Summa`, so one row is the whole disposal; its "KÄT."
    // twin repeats the same cash and is ignored below.
    "desim kirjaus otto": "SELL",
    "lunastus ap otto": "SELL",
    // "VAIHTO AP-OTTO"/"VAIHTO AP-JÄTTÖ" (a same-day ETF/fund merger: the
    // old ISIN's units removed, the new ISIN's units added, both legs at
    // `Summa: 0`) and "DESIM. ULOSKIRJ. KÄT"/"DESIM KIRJAUS OTTO" (Nordnet's
    // internal handling of one fractional-share cash-out event) are all
    // deliberately absent.
    //
    // An earlier version of this config mapped the VAIHTO pair to
    // TRANSFER_OUT/TRANSFER_IN with `amount: 0`, matching the real
    // `Summa`. Review caught that this silently corrupts tax data:
    // `core/costbasis.ts` derives a TRANSFER_IN lot's cost basis from
    // `-amount` (+ fee), so a zero amount books the merged-in holding at
    // EUR 0 acquisition cost -- its *entire* eventual sale proceeds would
    // be reported as gain. The real cost basis is sitting in the export's
    // `Hankinta-arvo` column, but there is no field in `DraftTxn` that can
    // carry it without a different corruption: setting `amount` to
    // `-Hankinta-arvo` (to get a true cost basis) would also falsely
    // reduce the account's cash balance in `core/ledger.ts`'s `cashAt`,
    // which sums every transaction's `amount` unconditionally -- no cash
    // actually moved in a merger. Routing it through `fee` instead avoids
    // the cash-balance corruption but corrupts fee-total reporting
    // instead (there was no real EUR 300+ commission on this trade).
    // A same-day offsetting pair (TRANSFER_OUT `amount: +Hankinta-arvo`,
    // TRANSFER_IN `amount: -Hankinta-arvo`, netting to zero cash) was also
    // considered and rejected: it requires assuming `Hankinta-arvo` is the
    // *carried-over* cost basis rather than a fair-market-value repricing
    // at conversion (some ETF share-class conversions carry the original
    // cost basis forward for tax purposes; others are a taxable disposal
    // and reacquisition) -- a real tax-treatment judgement call, not
    // something inferable from one CSV row, and getting it wrong here
    // corrupts the same tax data this whole task exists to protect.
    // Left unmapped so each instance surfaces as a review problem instead
    // of entering the ledger with a silently wrong cost basis.
  },
  signature: ["Tapahtumatyyppi", "ISIN", "Summa"],
};

/**
 * OP offers no CSV export. What existed here before (a `csv_op` config
 * describing a semicolon-delimited file) described a file that does not
 * exist -- see §10a A3. Transactions instead come from copying OP's web
 * transaction table and pasting it in.
 *
 * This is **not a delimited format** -- see `op-paste.ts` for the parser
 * and the full reasoning; this config only carries the field mapping
 * `parseOpPaste`'s output (a `RawRow[]` shaped like any other) feeds into
 * `mapRows`. It is an `OpPasteConfig`, not a `BrokerCsvConfig`: there is no
 * `encoding`/`delimiter` (there is no delimiter at all) and no single
 * header row for a `signature` match to run against.
 *
 * Column names match `parseOpPaste`'s canonical headers, which already
 * merge OP's two-line-wrapped labels ("Tapahtumapäivämäärä", "Kulut /
 * Korot / Verot") -- see that file.
 *
 * Two things specific to this broker, beyond the parsing itself:
 *  - Dates are `dd.mm.yyyy` (`dateFormat: "fi"`).
 *  - Every numeric cell carries a trailing unit label ("1,0453   kpl",
 *    "286,99   EUR", with multiple internal spaces) -- `stripUnitSuffixes:
 *    true` strips it before parsing.
 *  - `Yhteensä` (the total) is unsigned: a 300 EUR buy and a 300 EUR sell
 *    render identically. `amountSign` re-signs the parsed magnitude from
 *    the row's own type label instead of trusting the printed text. A
 *    label with no entry here defaults to +1 in `mapRows`, but every
 *    label actually mapped below has an explicit entry so that default is
 *    never reached for a real row -- only for a bug that adds a type to
 *    `typeMap` and forgets `amountSign`.
 *
 * There is no ISIN column at all -- `columns` has no `isin` entry, so
 * every row resolves (or fails to resolve) by instrument name alone
 * through mapRows' unknown-instrument tracking. No ISIN is invented.
 *
 * OSTO (buy), MYYNTI (sell) and OSINKO (dividend) are mapped -- the three
 * labels observed across real pastes. OSINKO's `Määrä` is shares *held* on
 * the payment date, not units transacted, and `Kurssi` is the dividend per
 * share, not a trade price; `mapRows` forces `quantity: 0` for every
 * DIVIDEND-typed row precisely so this shares-held figure can never be
 * mistaken for a trade. A label outside this set (e.g. a deposit made
 * through OP rather than a purchase) surfaces as a review problem instead
 * of being guessed at.
 *
 * Unverified, flagged rather than assumed: whether OP's web view ever
 * emits a transaction type beyond these three, and whether a MYYNTI row
 * ever appears without a fee (every real MYYNTI example seen so far has
 * one).
 */
export const OP_WEB_PASTE: OpPasteConfig = {
  broker: "op",
  dateFormat: "fi",
  stripUnitSuffixes: true,
  columns: {
    instrumentName: "Laji",
    type: "Tapahtuma",
    tradeDate: "Tapahtumapäivämäärä",
    quantity: "Määrä",
    unitPrice: "Kurssi",
    fee: "Kulut / Korot / Verot",
    amount: "Yhteensä",
  },
  typeMap: {
    osto: "BUY",
    myynti: "SELL",
    osinko: "DIVIDEND",
  },
  amountSign: {
    osto: -1,
    myynti: 1,
    osinko: 1,
  },
};

/**
 * Every genuinely delimited (CSV-shaped) broker config, for `parseCsv` and
 * `detectBroker`. `OP_WEB_PASTE` is deliberately not here: it is not a
 * `BrokerCsvConfig` and does not go through `parseCsv`/`detectBrokerConfig`
 * at all (see `op-paste.ts`). It has its own routes instead --
 * `POST /api/imports/op-paste/preview` and `POST /api/imports/op-paste/commit`
 * (Task 20) -- which take a JSON `{ text, accountId }` body (pasted text,
 * not a file) and feed `OP_WEB_PASTE` + `parseOpPaste`'s output into the
 * same `mapRows`/`commitDraft` pipeline the file-upload routes use.
 */
export const BROKER_CONFIGS: readonly BrokerCsvConfig[] = [NORDNET];

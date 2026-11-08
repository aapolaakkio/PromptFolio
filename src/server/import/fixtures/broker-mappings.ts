/**
 * The field mappings the hand-written Nordnet and OP importers used, kept as
 * test fixtures: `map.test.ts` exercises `mapRows` with them, and the reference
 * recipes in `recipe/broker-reference.ts` are built from them so a recipe and
 * the mapping it replaced cannot drift apart. No production code reads these;
 * every import goes through a recipe.
 */
import type { BrokerCsvConfig, OpPasteConfig } from "../types.ts";

/**
 * Read off a real Nordnet export (288 rows, 30 columns): UTF-16LE with a BOM,
 * tab-delimited, CRLF.
 *
 * Five columns are named `Valuutta`, each qualifying the value before it, so
 * they are addressed positionally rather than by name -- a name-keyed map would
 * keep only the last.
 *
 * `typeMap` covers exactly the labels seen in real exports. Anything else
 * surfaces for review rather than being mis-booked, and that includes every leg
 * of a two-row event whose twin carries the same units or cash: booking one on
 * its own would double a position or a balance.
 */
export const NORDNET: BrokerCsvConfig = {
  broker: "nordnet",
  encoding: "utf-16le",
  delimiter: "\t",
  dateFormat: "iso",
  columns: {
    externalId: "Id",
    portfolio: "Salkku",
    tradeDate: "Kauppapäivä",
    type: "Tapahtumatyyppi",
    instrumentName: "Arvopaperi",
    isin: "ISIN",
    quantity: "Määrä",
    unitPrice: "Kurssi",
    costBasis: "Hankinta-arvo",
    fee: "Kokonaiskulut",
    amount: "Summa",
    note: "Tapahtumateksti",
  },
  columnPositions: {
    // The `Valuutta` after `Summa`: what the cash settled in, and the only one
    // of the five filled on every row.
    currency: 15,
    // The `Valuutta` after `Tulos`: the instrument's own currency, which is USD
    // for a US share bought through a broker whose cash leg is EUR.
    priceCurrency: 19,
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
    // "OST." is osakesäästötili, not "osto": these are that account's cash legs.
    "talletus ost.": "DEPOSIT",
    "nosto ost.": "WITHDRAWAL",
    // Tax withheld on an OST withdrawal. FEE, not WITHDRAWAL: the money leaves
    // permanently but never reaches the investor, and calling it a withdrawal
    // would tell the money-weighted return it was taken out and enjoyed.
    "pääomatulovero ost": "FEE",
    // Both legs of a share swap. OTTO removes the old units; JÄTTÖ brings the
    // new ones and is the only row stating the acquisition value riding across,
    // which is why `columns.costBasis` exists. Same trade date, so the
    // portfolio's value does not jump on either side.
    "vaihto ap-otto": "TRANSFER_OUT",
    "vaihto ap-jättö": "TRANSFER_IN",
    // The units-and-cash leg of a fractional cash-out or a tender settlement:
    // one row is the whole disposal, and its "KÄT." twin repeats the cash.
    "desim kirjaus otto": "SELL",
    "lunastus ap otto": "SELL",
    // The VAIHTO and DESIM pairs are deliberately absent.
    //
    // Mapping VAIHTO to TRANSFER_OUT/TRANSFER_IN at the real `Summa: 0` books
    // the merged-in holding at zero cost, so its whole eventual sale reads as
    // gain. The true basis is in `Hankinta-arvo`, but no field can carry it:
    // through `amount` it falsely moves cash, through `fee` it invents a
    // commission, and an offsetting pair assumes the basis carries over rather
    // than the conversion being a taxable disposal -- a tax judgement no single
    // CSV row settles. Left unmapped so each one surfaces for review.
  },
  signature: ["Tapahtumatyyppi", "ISIN", "Summa"],
};

/**
 * OP publishes no CSV export: transactions come from copying its web table.
 *
 * Not a delimited format at all -- `op-paste.ts` holds the parser; this config
 * only carries the field mapping its output feeds into `mapRows`. Hence
 * `OpPasteConfig` rather than `BrokerCsvConfig`: no encoding, no delimiter, and
 * no header row for a signature to match.
 *
 * Three things are specific to this broker. Dates are `dd.mm.yyyy`. Every
 * numeric cell carries a trailing unit label ("1,0453   kpl"), stripped before
 * parsing. And `Yhteensä` is unsigned -- a 300 EUR buy and a 300 EUR sell print
 * identically -- so the sign comes from the row's own type label.
 *
 * There is no ISIN column, so rows resolve by instrument name alone. No ISIN is
 * invented.
 *
 * OSINKO's `Määrä` is shares held on the payment date, not units transacted, so
 * `mapRows` forces a dividend's quantity to zero rather than letting a
 * shares-held figure be read as a trade. The corporate actions OP emits carry a
 * quantity and no money lines at all: MERKINTÄ subscribes shares for cash and is
 * an ordinary buy; VAIHTO - JÄTTÖ carries the count a reverse split results in,
 * which is what a SPLIT row means here, and its OTTO twin is ignored so the
 * split is not applied twice; YHDISTELY moves shares between two lines of the
 * same company; subscription rights arriving and being used up have no cash, no
 * lasting position and no ISIN, so both are ignored.
 *
 * Known limitation: OP's paste has no acquisition-value column, so a YHDISTELY
 * transfer-in gets no cost basis. The cost stays with the line the shares left
 * and realises there instead of following them.
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
    merkintä: "BUY",
    "vaihto - jättö": "SPLIT",
    "yhdistely - jättö": "TRANSFER_IN",
    "yhdistely - otto": "TRANSFER_OUT",
  },
  ignoredTypes: {
    "vaihto - otto":
      "Osakkeiden yhdistämisen vanha kappalemäärä; uusi määrä on jo VAIHTO - JÄTTÖ -rivillä.",
    "irrotus - jättö":
      "Merkintäoikeuksien irrotus. Parinsa (MERKINTÄOIK. OTTO) kanssa nettovaikutus on nolla.",
    "merkintäoik. otto":
      "Merkintäoikeuksien käyttö. Parinsa (IRROTUS - JÄTTÖ) kanssa nettovaikutus on nolla.",
  },
  amountSign: {
    osto: -1,
    myynti: 1,
    osinko: 1,
    merkintä: -1,
    "vaihto - jättö": 1,
    "yhdistely - jättö": -1,
    "yhdistely - otto": 1,
  },
};

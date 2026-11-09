/** Field mappings of the retired Nordnet and OP importers; recipe/broker-reference.ts is built from them so the two cannot drift. */
import type { BrokerCsvConfig, OpPasteConfig } from "../types.ts";

/** Read off a real Nordnet export: UTF-16LE with a BOM, tab-delimited. Five columns are named Valuutta, so they are addressed by position. Labels not listed surface for review. */
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
    currency: 15,
    priceCurrency: 19,
  },
  ignoredTypes: {
    "desim. uloskirj. kät":
      "Cash side of a fractional-share redemption; the same amount is already on the DESIM KIRJAUS OTTO row.",
    "lunastus ap kät.":
      "Cash side of a redemption; the same amount is already on the LUNASTUS AP OTTO row.",
    "ap otto":
      "Removal of a subscription commitment. Together with its pair (JÄTTÖ SIIRTO) the net effect is zero, and the row has no ISIN.",
    "jättö siirto":
      "Booking of a subscription commitment. Together with its pair (AP OTTO) the net effect is zero, and the row has no ISIN.",
  },
  typeMap: {
    osto: "BUY",
    myynti: "SELL",
    talletus: "DEPOSIT",
    nosto: "WITHDRAWAL",
    "reaaliaikainen talle": "DEPOSIT",
    "etf_kk säästön palvelumaksu": "FEE",
    "per etf-kk säästön palvemaksu": "FEE",
    "pääomit ylit.korko": "INTEREST",
    lainakorko: "INTEREST",
    osinko: "DIVIDEND",
    "talletus ost.": "DEPOSIT",
    "nosto ost.": "WITHDRAWAL",
    "pääomatulovero ost": "FEE",
    "vaihto ap-otto": "TRANSFER_OUT",
    "vaihto ap-jättö": "TRANSFER_IN",
    "desim kirjaus otto": "SELL",
    "lunastus ap otto": "SELL",
    // VAIHTO and DESIM pairs are left unmapped: no field can carry the true Hankinta-arvo (acquisition value), so each surfaces for review.
  },
  signature: ["Tapahtumatyyppi", "ISIN", "Summa"],
};

/** OP has no CSV export: a pasted web table. Yhteensä is unsigned, so the sign comes from the type label; no ISIN column. Known limitation: no acquisition-value column, so a YHDISTELY transfer-in gets no cost basis. */
export const OP_WEB_PASTE: OpPasteConfig = {
  broker: "op",
  dateFormat: "dmy",
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
      "Old share count of a share consolidation; the new quantity is already on the VAIHTO - JÄTTÖ row.",
    "irrotus - jättö":
      "Detaching of subscription rights. Together with its pair (MERKINTÄOIK. OTTO) the net effect is zero.",
    "merkintäoik. otto":
      "Use of subscription rights. Together with its pair (IRROTUS - JÄTTÖ) the net effect is zero.",
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

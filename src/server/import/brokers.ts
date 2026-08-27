import type { BrokerCsvConfig } from "./types";

/**
 * These configs are informed guesses at the real Nordnet/OP export formats,
 * not verified against an actual downloaded export. Before relying on them,
 * download one real export from each bank, drop it in `fixtures/` (with
 * amounts and ids altered), and adjust `columns`, `encoding`, `delimiter`
 * and `typeMap` to match. If Nordnet's export turns out to be UTF-16LE and
 * tab-delimited, that is a two-line change here and nothing else moves —
 * which is the entire point of the config indirection.
 */
export const NORDNET: BrokerCsvConfig = {
  broker: "nordnet",
  encoding: "utf-8",
  delimiter: ";",
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
    currency: "Valuutta",
    amount: "Summa",
  },
  typeMap: {
    osto: "BUY",
    köp: "BUY",
    buy: "BUY",
    myynti: "SELL",
    sälj: "SELL",
    sell: "SELL",
    osinko: "DIVIDEND",
    utdelning: "DIVIDEND",
    talletus: "DEPOSIT",
    insättning: "DEPOSIT",
    nosto: "WITHDRAWAL",
    uttag: "WITHDRAWAL",
    palkkio: "FEE",
    korko: "INTEREST",
    "arvopaperisiirto sisään": "TRANSFER_IN",
    "arvopaperisiirto ulos": "TRANSFER_OUT",
    split: "SPLIT",
  },
  signature: ["Tapahtumatyyppi", "ISIN", "Summa"],
};

export const OP: BrokerCsvConfig = {
  broker: "op",
  encoding: "utf-8",
  delimiter: ";",
  dateFormat: "fi",
  columns: {
    tradeDate: "Päivämäärä",
    type: "Laji",
    instrumentName: "Kohde",
    isin: "ISIN",
    quantity: "Osuudet",
    unitPrice: "Hinta",
    fee: "Kulut",
    currency: "Valuutta",
    amount: "Yhteensä",
  },
  typeMap: {
    merkintä: "BUY",
    osto: "BUY",
    lunastus: "SELL",
    myynti: "SELL",
    tuotonmaksu: "DIVIDEND",
    osinko: "DIVIDEND",
    talletus: "DEPOSIT",
    nosto: "WITHDRAWAL",
    palkkio: "FEE",
    korko: "INTEREST",
  },
  signature: ["Laji", "Osuudet", "Yhteensä"],
};

export const BROKER_CONFIGS: readonly BrokerCsvConfig[] = [NORDNET, OP];

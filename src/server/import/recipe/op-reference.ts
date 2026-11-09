import type { BankRecipe } from "./types.ts";

const DATE = String.raw`\d{1,2}\.\d{1,2}\.\d{4}`;
const AMOUNT = String.raw`[+−-]?\d{1,3}(?:[  ]\d{3})*,\d{2}`;
const WORD = String.raw`[A-ZÄÖÅ][A-ZÄÖÅ.-]*`;

/** `bank-pdf.ts` patterns restated: the reference the interpreter is held to. Finnish keywords are OP page furniture. */
export const OP_STATEMENT_RECIPE: BankRecipe = {
  kind: "bank",
  // Each keyword ends at a word boundary: a payee named "BIC-ATRIA OY" is not furniture.
  skip: [
    String.raw`^(?:Tilinumero|BIC|Kirjauspäivä|Kirjaus-|päivä|Arvopäivä|Määrä,|euroa|Selitys|Maksunsaaja/maksaja|Viesti|Viite|Saajan|Tiliote|Käyttötili|Määräaikainen|Eräpäivä|Ajalta|Asiakkaan tulostama|Jatkuu)(?=\s|$)`,
    String.raw`^\d+ \(\d+\)$`,
    String.raw`^[A-Z]{6}[A-Z0-9]{2,5}$`,
    String.raw`^[A-Z]{2}\d{2}(\s\d{4})+(\s\d{1,4})?$`,
    `^${DATE}\\s*-\\s*${DATE}$`,
    String.raw`^(\d{6}\*+\d{4}|MF NRO|VARMENTAJA|OSTOPVM)`,
    `^${AMOUNT}\\s+(Panot|Otot)\\s+yhteensä`,
    `^${AMOUNT}\\s+Saldo\\s+${DATE}$`,
    `^${DATE}$`,
  ],
  recordStart:
    `^(?<date>${DATE})\\s+(?<amount>${AMOUNT})` +
    `(?:\\s+(?<label>${WORD}(?:\\s+${WORD})*)(?=\\s|$))?` +
    String.raw`(?:.*?\s(?<externalId>[0-9A-Z]{16,})(?=\s|$))?.*$`,
  // The archive id must carry a digit, or a payee printed as one long unspaced word is eaten as an id.
  continuation: [
    String.raw`^Viesti:\n(?<message>.+)$`,
    String.raw`^Viesti:$`,
    String.raw`^(?=[0-9A-Z]*[0-9])(?<externalId>[0-9A-Z]{16,})$`,
  ],
  restField: "counterparty",
  header: {
    from: `^${AMOUNT}\\s+Saldo\\s+(?<value>${DATE})$`,
    to: `^${AMOUNT}\\s+Saldo\\s+(?<value>${DATE})$`,
    openingBalance: `^(?<value>${AMOUNT})\\s+Saldo\\s+${DATE}$`,
    closingBalance: `^(?<value>${AMOUNT})\\s+Saldo\\s+${DATE}$`,
    maturityDate: `^Eräpäivä\\n(?:.*\\n)*?(?<value>${DATE})$`,
  },
  dateFormat: "d.m.yyyy",
  money: {
    decimal: ",",
    thousands: " ",
    negative: "leading",
    twoColumn: false,
  },
};

import type { BankRecipe } from "./types.ts";

const DATE = String.raw`\d{1,2}\.\d{1,2}\.\d{4}`;
/** The sign is optional, and the thousands separator is either kind of space. */
const AMOUNT = String.raw`[+−-]?\d{1,3}(?:[  ]\d{3})*,\d{2}`;
/** A word of a label, with the dots and hyphens OP puts in "TALLETUSAUTOM.". */
const WORD = String.raw`[A-ZÄÖÅ][A-ZÄÖÅ.-]*`;

/**
 * OP's PDF statement, written as a recipe rather than as code. The patterns are
 * `bank-pdf.ts`'s own, restated: this is the reference the interpreter is held
 * to, and the worked example the generation prompt shows the model.
 */
export const OP_STATEMENT_RECIPE: BankRecipe = {
  kind: "bank",
  skip: [
    String.raw`^(Tilinumero|BIC|Kirjaus|päivä|Arvopäivä|Määrä,|euroa|Selitys|Maksunsaaja/maksaja|Viesti$|Viite|Saajan|Tiliote|Käyttötili|Määräaikainen|Eräpäivä|Ajalta|Asiakkaan tulostama|Jatkuu)`,
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
  continuation: [
    String.raw`^Viesti:\n(?<message>.+)$`,
    String.raw`^Viesti:$`,
    String.raw`^(?<externalId>[0-9A-Z]{16,})$`,
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

import type { BankCsvRecipe } from "./csv-recipe.ts";

/**
 * OP's account export, described the way a model is asked to: the hand-written
 * reference the CSV recipe engine is tested against. Semicolon-delimited, ISO
 * dates, a Finnish decimal comma. The archive id is unique per transaction, so
 * an overlapping re-import skips what is stored instead of doubling a year.
 */
export const OP_BANK_CSV_RECIPE: BankCsvRecipe = {
  kind: "bank-csv",
  delimiter: ";",
  columns: {
    date: "Kirjauspäivä",
    amount: "Määrä EUROA",
    debit: null,
    credit: null,
    label: "Selitys",
    counterparty: "Saaja/Maksaja",
    message: "Viesti",
    externalId: "Arkistointitunnus",
  },
  dateFormat: "yyyy-mm-dd",
  money: { decimal: ",", thousands: "", negative: "leading", twoColumn: false },
  interestLabels: ["TALLETUSKORKO", "KORKO"],
};

/**
 * OP's credit card log: the account export's shape under other header names,
 * with a decimal point. None of its labels is interest paid in: "Korko" on a
 * card is money owed, and it arrives negative.
 */
export const OP_CREDIT_CSV_RECIPE: BankCsvRecipe = {
  kind: "bank-csv",
  delimiter: ";",
  columns: {
    date: "Kirjauspäivä",
    amount: "Määrä",
    debit: null,
    credit: null,
    label: "Selite",
    counterparty: "Saaja",
    message: null,
    externalId: "Arkistointitunnus",
  },
  dateFormat: "yyyy-mm-dd",
  money: { decimal: ".", thousands: "", negative: "leading", twoColumn: false },
  interestLabels: [],
};

import type { BankCsvRecipe } from "./csv-recipe.ts";

/** OP account export as a model is asked to describe it. Headers are Finnish: Kirjauspäivä booking date, Määrä amount, Selitys description, Saaja/Maksaja payee, Viesti message, Arkistointitunnus archive id. */
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

/** On a card, "Korko" is money owed, arriving negative. */
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

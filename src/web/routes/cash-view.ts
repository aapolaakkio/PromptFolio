/**
 * How a balance's reachability reads on screen.
 *
 * A deposit locked until a date says so with the date; one whose terms nobody
 * entered says that instead of implying it is spendable, because "we do not
 * know when this frees up" and "you can use it now" are different answers.
 */
export const availabilityLabel = (row: {
  locked: boolean;
  availableFrom: string | null;
}): string => {
  if (!row.locked) return "Käytettävissä";
  return row.availableFrom === null
    ? "Sidottu, eräpäivä ei tiedossa"
    : `Sidottu ${row.availableFrom} asti`;
};

/**
 * What the import did to the account's opening balance, and whether the ledger
 * now agrees with the statement.
 *
 * A difference that is not zero is worth saying loudly: it means this account
 * already held rows for the period, which is what happens when the same month
 * arrives twice in two formats.
 */
/**
 * What the import did with the deposit's maturity date, when there was one.
 * Silent when nothing happened -- an account that already agreed with its
 * statement needs no sentence about it.
 */
export const describeMaturity = (result: {
  maturityDate: string | null;
  maturityConflict: string | null;
}): string | null => {
  if (result.maturityConflict !== null) {
    return `Tiliote ilmoittaa eräpäiväksi ${result.maturityConflict}, tilille on kirjattu ${result.maturityDate}. Tarkista kumpi on oikea.`;
  }
  return result.maturityDate === null ? null : `Eräpäivä ${result.maturityDate}.`;
};

export const describeReconciliation = (result: {
  differenceEur: string;
  openingBalanceWritten: boolean;
  openingBalanceDate: string;
}): string => {
  const opening = result.openingBalanceWritten
    ? `Alkusaldo kirjattiin ${result.openingBalanceDate}.`
    : `Alkusaldo säilytettiin ennallaan (${result.openingBalanceDate}), koska aiempi tiliote ulottuu kauemmas.`;
  return result.differenceEur === "0.00"
    ? `${opening} Saldo täsmää tiliotteen kanssa.`
    : `${opening} HUOM: saldo eroaa tiliotteesta ${result.differenceEur} € — tilillä on todennäköisesti jo samat tapahtumat toisesta tiedostosta.`;
};

export const ENTRY_LABELS = new Map<string, string>([
  ["OPENING_BALANCE", "Alkusaldo"],
  ["DEPOSIT", "Talletus"],
  ["WITHDRAWAL", "Nosto"],
  ["INTEREST", "Korko"],
]);

/**
 * What an import actually did, in one sentence.
 *
 * Both numbers are always named, including a zero: "0 uutta, 5 jo tuotua" is
 * the answer that tells someone their re-import worked as intended, whereas a
 * bare "valmis" leaves them wondering whether it doubled anything.
 */
export const describeImport = (result: {
  inserted: number;
  skipped: number;
  enriched?: number;
  problems: readonly unknown[];
}): string => {
  const parts = [`${result.inserted} uutta tapahtumaa`, `${result.skipped} jo tuotua`];
  // Worth saying: it is the reason to import the same period in both formats,
  // and otherwise invisible -- the rows were already there.
  if ((result.enriched ?? 0) > 0) parts.push(`${result.enriched} täydennettyä saajatietoa`);
  if (result.problems.length > 0) parts.push(`${result.problems.length} riviä ei voitu lukea`);
  return `${parts.join(", ")}.`;
};

/**
 * How a reconciliation came out.
 *
 * A zero difference is the good case and says so plainly: it means the imported
 * rows still add up to what the bank reports, which is the check this screen
 * exists to give.
 */
export const describeBalance = (result: {
  statedEur: string;
  derivedFromRowsEur: string;
  openingBalanceEur: string;
  openingBalanceDate: string;
}): string =>
  result.openingBalanceEur === "0.00"
    ? `Täsmää: tapahtumat selittävät koko saldon ${result.statedEur} €.`
    : `Alkusaldoksi kirjattiin ${result.openingBalanceEur} € (${result.openingBalanceDate}); ` +
      `tapahtumat selittävät ${result.derivedFromRowsEur} €.`;

/** Why a row was left out of the spending figures, in the words the screen shows. */
export const EXCLUDED_LABELS = {
  income: "tuloa",
  "internal-transfer": "oma siirto",
  investment: "sijoitus",
  "opening-balance": "alkusaldo",
  "other-currency": "muu valuutta",
} as const;

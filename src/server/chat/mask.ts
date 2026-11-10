// No server-only imports: chart summaries and history notes use this too.

const IBAN = /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]){10,30}/g;
/** Six or more digits, maybe split by single spaces or hyphens; not inside an ISIN, a decimal amount or a date. */
const DIGIT_RUN = /(?<![\dA-Za-z.,#])\d(?:[ -]?\d){5,}(?![\d]|[.,]\d)/g;
const ISO_DATE = /^\d{4}-\d{2}(?:-\d{2})?$/;

/** What the model sees of a name the owner or a bank wrote: account numbers masked, everything else kept. */
export const maskAccountNumbers = (text: string): string =>
  text.replace(IBAN, "…").replace(DIGIT_RUN, (run) => (ISO_DATE.test(run) ? run : "…"));

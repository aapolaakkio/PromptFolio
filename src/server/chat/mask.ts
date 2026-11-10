// No server-only imports: chart summaries and history notes use this too.

const MASK = "…";
const MIN_IBAN_DIGITS = 8;

// Never a tab or line break, so a mask stays inside one cell of a file.
const SEP = String.raw`[    _-]`;
const DATE = String.raw`(?:19|20)\d{2}-(?:0[1-9]|1[0-2])(?:-[0-3]\d)?(?![\d-]|[.,]\d)`;
const EMAIL_CHAR = String.raw`\p{L}\p{N}_.+-`;

/** One pass, leftmost first. No pattern has a repeat inside a repeat with an optional part: file lines are long and not ours. */
const CANDIDATE = new RegExp(
  [
    String.raw`(?<isin>(?<![A-Za-z0-9])[A-Z]{2}[A-Z0-9]{9}\d(?![A-Za-z0-9]))`,
    String.raw`(?<date>(?<!\d|\d[.,])${DATE})`,
    // Groups of an IBAN or a card may stand up to three spaces apart, as PDF text often has them.
    String.raw`(?<iban>(?<![A-Za-z0-9])[A-Za-z]{2}\d{2}(?:(?:${SEP}{1,3}|\.)?[A-Za-z0-9]{4}){2,7}(?:${SEP}{0,3}[A-Za-z0-9]{1,4}|\.\d{1,4})?(?![A-Za-z0-9]))`,
    String.raw`(?<dotted>(?<!\d|\d[.,/])\d+(?:[./]\d+){2,}(?![./]?\d))`,
    // A Finnish personal identity code, an email address, a partly starred card number, a card in groups of four.
    String.raw`(?<!\d)\d{6}[-+A-FU-Y]\d{3}[0-9A-Y](?![A-Za-z0-9])`,
    String.raw`(?<![${EMAIL_CHAR}])[${EMAIL_CHAR}]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+`,
    String.raw`(?<![*•])(?:\d[ -]?){0,6}[*•]{2,}(?:[ -][*•]+)*[ -]?\d{2,4}`,
    String.raw`(?<!\d)\d{4}(?:${SEP}{1,3}\d{4}){2,4}(?!\d)`,
    // Nine digits or more: masked even between the commas of a CSV row. Six to eight: unless it is the whole or fraction part of a decimal.
    String.raw`(?<long>(?<!\d)\+?\d(?:${SEP}?(?!${DATE})\d){8,})`,
    String.raw`(?<short>(?<!\d|\d[.,])\+?\d(?:${SEP}?(?!${DATE})\d){5,}(?!\d|[.,]\d))`,
  ].join("|"),
  "gu",
);

/** The ISIN check digit: Luhn over the digits with each letter written as 10..35. */
const hasIsinCheckDigit = (code: string): boolean => {
  const digits = code.replace(/[A-Z]/g, (letter) => String(letter.charCodeAt(0) - 55));
  const sum = digits
    .split("")
    .reverse()
    .reduce((total, char, at) => {
      const doubled = at % 2 === 1 ? Number(char) * 2 : Number(char);
      return total + (doubled > 9 ? doubled - 9 : doubled);
    }, 0);
  return sum % 10 === 0;
};

const MIN_DOTTED_DIGITS = 9;
/** 1.234.567 is an amount with thousands separators, not an identifier. */
const THOUSANDS = /^\d{1,3}(?:\.\d{3})+$/;

/** 1 234 567 is an amount, 20261103 a date and 2024-2026 a span of years; none of them names an account. */
const PLAIN_NUMBER = new RegExp(
  [
    String.raw`^[1-9]\d{0,2}(?:[ \u00a0\u202f\u2009]\d{3})+$`,
    String.raw`^(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])$`,
    String.raw`^(?:19|20)\d{2}-(?:19|20)\d{2}$`,
  ].join("|"),
);

const digitCount = (text: string): number => text.replace(/\D/g, "").length;

const masked = (text: string, hide: (found: string) => string): string =>
  text.replace(CANDIDATE, (match: string, ...found: (string | undefined)[]) => {
    const [isin, date, iban, dotted, long, short] = found;
    if (date !== undefined) return match;
    if ((long ?? short) !== undefined && PLAIN_NUMBER.test(match)) return match;
    if (dotted !== undefined && (digitCount(match) < MIN_DOTTED_DIGITS || THOUSANDS.test(match))) {
      return match;
    }
    if (isin !== undefined) return hasIsinCheckDigit(match) ? match : hide(match);
    if (iban !== undefined && digitCount(match) < MIN_IBAN_DIGITS) {
      // IBAN-shaped words ("AB12 some word here"): keep them, but still mask what follows the prefix.
      return match.slice(0, 4) + masked(match.slice(4), hide);
    }
    return hide(match);
  });

/**
 * What the model sees of a name the owner or a bank wrote: account numbers, personal identity codes and email addresses masked, everything else kept.
 * Kept: a real ISIN (valid check digit), a year-month or ISO date, a decimal amount. Fails closed: any other long digit run is masked, whatever precedes it.
 */
export const maskAccountNumbers = (text: string): string => masked(text, () => MASK);

const STAND_IN = /…|(?<!\p{L})x{3,}(?!\p{L})/u;

/** True when text a model wrote carries a mask it was shown: saving it would store the mask in place of the real value. */
export const hasStandIn = (text: string): boolean => STAND_IN.test(text);

/**
 * The same finds with every digit and letter swapped for a stand-in, so the text keeps its shape.
 * For file samples a model writes a reading recipe from: the recipe is run on the real file by the app, so the model needs the layout, not the numbers.
 */
export const maskForFileSample = (text: string): string =>
  masked(text, (found) => found.replace(/\d/g, "0").replace(/[A-Za-z]/g, "x"));

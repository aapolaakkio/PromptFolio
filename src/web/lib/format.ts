/**
 * `Intl.NumberFormat('fi-FI', ...)` renders a negative sign as U+2212
 * (MINUS SIGN), not ASCII U+002D (hyphen-minus) -- verified directly
 * against this project's Bun/ICU build, for both `currency` and `percent`
 * styles. Every other locale-specific character (comma decimal separator,
 * narrow no-break space grouping, trailing "€"/"%") is left exactly as
 * Intl produces it; only the minus glyph is normalised to ASCII, so a
 * formatted figure copy-pastes and greps like any other plain text.
 */
const toAsciiMinus = (formatted: string): string => formatted.replace(/−/g, "-");

const EUR = new Intl.NumberFormat("fi-FI", {
  style: "currency",
  currency: "EUR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const QTY = new Intl.NumberFormat("fi-FI", { minimumFractionDigits: 0, maximumFractionDigits: 6 });
const PCT = new Intl.NumberFormat("fi-FI", {
  style: "percent",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Formats a euro amount that arrived from the API as a decimal string
 * (e.g. "1234.56"). `Number(value)` is safe here: the value is only ever
 * displayed, never fed back into arithmetic -- the server has already
 * rounded it to two decimals.
 */
export const eur = (value: string): string => toAsciiMinus(EUR.format(Number(value)));

/**
 * Formats a quantity string, trimming trailing zeros (Intl's own grouping
 * keeps up to 6 fraction digits, dropping ones that are exactly zero).
 */
export const qty = (value: string): string => toAsciiMinus(QTY.format(Number(value)));

/** Formats a return ratio (e.g. 0.0734) as a signed Finnish percentage. */
export const pct = (ratio: number): string =>
  toAsciiMinus(`${ratio > 0 ? "+" : ""}${PCT.format(ratio)}`);

/** Formats an ISO date (YYYY-MM-DD) as the Finnish d.m.yyyy form. */
export const fiDate = (iso: string): string => {
  const [year, month, day] = iso.split("-");
  return `${Number(day)}.${Number(month)}.${year}`;
};

const EUR = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "EUR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const QTY = new Intl.NumberFormat("en-GB", { minimumFractionDigits: 0, maximumFractionDigits: 6 });
const PCT = new Intl.NumberFormat("en-GB", {
  style: "percent",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const DATE = new Intl.DateTimeFormat("en-GB", { dateStyle: "short", timeZone: "UTC" });
const DATETIME = new Intl.DateTimeFormat("en-GB", { dateStyle: "short", timeStyle: "short" });

/** `Number(value)` is safe: the value is only displayed, and the server already rounded it. */
export const eur = (value: string): string => EUR.format(Number(value));

export const qty = (value: string): string => QTY.format(Number(value));

/** A return ratio (e.g. 0.0734) as a signed percentage. */
export const pct = (ratio: number): string => `${ratio > 0 ? "+" : ""}${PCT.format(ratio)}`;

/** A weight (0..1) as an unsigned percentage: a proportion, not a gain or loss. */
export const share = (ratio: number): string => PCT.format(ratio);

/** An ISO date (YYYY-MM-DD) as dd/mm/yyyy. */
export const formatDate = (iso: string): string => DATE.format(new Date(`${iso}T00:00:00Z`));

/** A full ISO 8601 instant in the viewer's local time zone. */
export const formatDateTime = (iso: string): string => DATETIME.format(new Date(iso));

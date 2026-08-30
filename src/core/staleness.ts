import type { InstrumentKind, IsoDate } from "./types.ts";

/**
 * Whether a holding's price is old enough to deserve the "vanha" badge.
 *
 * A badge on every holding every weekend is a badge nobody reads. Two facts
 * decide the freshest price that can exist for a given day:
 *
 *  - **Markets close.** On a Saturday the newest close in existence is
 *    Friday's, so Friday's price is current, not late.
 *  - **Funds publish a day behind.** A fund's NAV for a given day appears the
 *    following evening, so the freshest NAV is the previous weekday's. Shares
 *    and ETFs quote intraday and have no such lag.
 *
 * The badge then means one thing: older than that. Note what this is NOT --
 * "not dated today". A months-old price is late whichever day of the week you
 * ask on, which is why this compares against an expected date rather than
 * exempting weekends outright.
 *
 * ponytail: weekends only, no Finnish holiday calendar. On Juhannus every
 * holding reads a day late for a day. Add a holiday list here if that grates.
 */
const isWeekend = (date: IsoDate): boolean => {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
};

const shiftDays = (date: IsoDate, days: number): IsoDate => {
  const moved = new Date(`${date}T00:00:00Z`);
  moved.setUTCDate(moved.getUTCDate() + days);
  return moved.toISOString().slice(0, 10);
};

/** The last weekday strictly before `date`. Friday for a Monday. */
export const previousWeekday = (date: IsoDate): IsoDate => {
  let previous = shiftDays(date, -1);
  while (isWeekend(previous)) previous = shiftDays(previous, -1);
  return previous;
};

/** `date` itself when it is a weekday, otherwise the Friday before it. */
const weekdayOnOrBefore = (date: IsoDate): IsoDate =>
  isWeekend(date) ? previousWeekday(date) : date;

/**
 * The newest price date that can exist for this kind of instrument as of `on`.
 * A price dated this or later is current; anything earlier is late.
 */
export const freshestPriceDate = (kind: InstrumentKind, on: IsoDate): IsoDate => {
  const trading = weekdayOnOrBefore(on);
  return kind === "fund" ? previousWeekday(trading) : trading;
};

/**
 * `on` is the date being valued, `priceDate` the date of the price actually
 * used (`null` when none exists at all -- that holding renders "ei hintaa", a
 * different and louder state than this one).
 */
export const isPriceStale = (args: {
  readonly kind: InstrumentKind;
  readonly priceDate: IsoDate | null;
  readonly on: IsoDate;
}): boolean => {
  const { kind, priceDate, on } = args;
  if (priceDate === null) return true;
  return priceDate < freshestPriceDate(kind, on);
};

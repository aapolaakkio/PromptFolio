import type { InstrumentKind, IsoDate } from "./types.ts";

// Stale means older than the freshest price that can exist: markets close on weekends, and
// funds publish the previous weekday's NAV; shares and ETFs quote intraday.
// ponytail: weekends only, no Finnish holiday calendar; add one if the Midsummer false stale grates.
const isWeekend = (date: IsoDate): boolean => {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
};

export const daysBetween = (from: IsoDate, to: IsoDate): number =>
  Math.round(
    (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000,
  );

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

/** Newest price date that can exist for this kind of instrument as of `on`. */
const freshestPriceDate = (kind: InstrumentKind, on: IsoDate): IsoDate => {
  const trading = weekdayOnOrBefore(on);
  return kind === "fund" ? previousWeekday(trading) : trading;
};

/** `priceDate` is the date of the price used; null (no price at all) renders "no price", a louder state. */
export const isPriceStale = (args: {
  readonly kind: InstrumentKind;
  readonly priceDate: IsoDate | null;
  readonly on: IsoDate;
}): boolean => {
  const { kind, priceDate, on } = args;
  if (priceDate === null) return true;
  return priceDate < freshestPriceDate(kind, on);
};

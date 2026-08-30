/**
 * True only for a string that is both `YYYY-MM-DD`-shaped AND names a real calendar day --
 * `fx.ts`'s ECB date parsing (`EcbHistDateParts`) validates the same shape but only
 * range-checks day-of-month (`00`-`31`) independent of month, which still lets through
 * e.g. `2024-02-31`. A human typing a date by hand is more error-prone than a machine-
 * generated ECB file, so this goes further: round-tripping through `Date.UTC` and checking
 * every component survives catches a day that does not exist in its own month (`2024-02-31`,
 * `2024-04-31`) and a nonsense month/day pair (`2024-99-99`) alike, without hand-rolling a
 * leap-year/days-per-month table `Date` already gets right.
 */
export const isRealCalendarDate = (value: string): boolean => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
};

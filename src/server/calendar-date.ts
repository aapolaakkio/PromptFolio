/** True only for a `YYYY-MM-DD` string naming a real calendar day. Round-trips through `Date.UTC` so `2024-02-31` and `2024-99-99` fail, without a days-per-month table (ECB's date parsing only range-checks day 00-31). */
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

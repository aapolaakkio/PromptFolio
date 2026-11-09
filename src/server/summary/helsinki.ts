const DAY_MS = 86_400_000;

const HELSINKI_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Helsinki",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** The calendar date in Finland at `now`: the owner's week turns over at Helsinki midnight, not UTC midnight. */
export const helsinkiToday = (now: Date): string => HELSINKI_DAY.format(now);

export const shiftDay = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

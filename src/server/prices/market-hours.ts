/**
 * When a listing's exchange is trading, from its Yahoo symbol's suffix. Local
 * opening hours with the exchange's own time zone, so daylight saving follows
 * the zone rather than a fixed UTC offset. Weekdays only.
 */
type Session = {
  readonly zone: string;
  /** Minutes after local midnight, both ends inclusive. */
  readonly open: number;
  readonly close: number;
};

const at = (hours: number, minutes = 0): number => hours * 60 + minutes;

const HELSINKI: Session = { zone: "Europe/Helsinki", open: at(10), close: at(18, 30) };
const XETRA: Session = { zone: "Europe/Berlin", open: at(9), close: at(17, 30) };
const STOCKHOLM: Session = { zone: "Europe/Stockholm", open: at(9), close: at(17, 30) };
const NEW_YORK: Session = { zone: "America/New_York", open: at(9, 30), close: at(16) };

const BY_SUFFIX: ReadonlyMap<string, Session> = new Map([
  ["HE", HELSINKI],
  ["DE", XETRA],
  ["ST", STOCKHOLM],
]);

// ponytail: no holiday calendar; a closed-exchange holiday costs a few wasted requests
const sessionFor = (symbol: string): Session => {
  const dot = symbol.lastIndexOf(".");
  if (dot === -1) return NEW_YORK;
  return BY_SUFFIX.get(symbol.slice(dot + 1).toUpperCase()) ?? XETRA;
};

const formatters = new Map<string, Intl.DateTimeFormat>();

const formatterFor = (zone: string): Intl.DateTimeFormat => {
  const cached = formatters.get(zone);
  if (cached !== undefined) return cached;
  const created = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  formatters.set(zone, created);
  return created;
};

const WEEKEND = new Set(["Sat", "Sun"]);

type LocalClock = { readonly weekday: string; readonly minutes: number };

const localClock = (zone: string, when: Date): LocalClock => {
  const parts = formatterFor(zone).formatToParts(when);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  return { weekday: part("weekday"), minutes: at(Number(part("hour")), Number(part("minute"))) };
};

export const isOpen = (symbol: string, when: Date): boolean => {
  const session = sessionFor(symbol);
  const { weekday, minutes } = localClock(session.zone, when);
  return !WEEKEND.has(weekday) && minutes >= session.open && minutes <= session.close;
};

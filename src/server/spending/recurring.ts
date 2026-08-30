import { EUR, formatMoney, type Money } from "../../core/money";
import type { IsoDate, Txn } from "../../core/types";
import { labelForCategory } from "./categories";
import { categoriseWith, type SpendingRule } from "./rules";

export type Cadence = "weekly" | "monthly" | "quarterly" | "yearly";

export type RecurringPayment = {
  readonly payee: string;
  readonly category: string;
  readonly categoryLabel: string;
  readonly cadence: Cadence;
  readonly count: number;
  /** The typical payment, as a positive figure: what leaves each time. */
  readonly typicalEur: string;
  /** What that comes to in a year at this cadence, which is the number people ask for. */
  readonly annualEur: string;
  readonly firstDate: IsoDate;
  readonly lastDate: IsoDate;
  /** False when the last payment is older than the cadence explains -- a cancelled one. */
  readonly active: boolean;
};

/** How many days apart each cadence's payments fall, and how often it recurs a year. */
const CADENCES: readonly {
  readonly cadence: Cadence;
  readonly min: number;
  readonly max: number;
  readonly perYear: number;
}[] = [
  { cadence: "weekly", min: 5, max: 9, perYear: 52 },
  { cadence: "monthly", min: 24, max: 38, perYear: 12 },
  { cadence: "quarterly", min: 80, max: 100, perYear: 4 },
  { cadence: "yearly", min: 330, max: 400, perYear: 1 },
];

/**
 * How much a recurring payment's amount may wander and still be one.
 *
 * This is what separates a subscription from the weekly shop. Both are paid to
 * the same payee on a regular rhythm; only one of them is the same amount every
 * time. Without this every grocery chain would be reported as a bill the
 * household is committed to, which is the opposite of useful.
 */
const AMOUNT_TOLERANCE = 0.15;

/** How many payments before a rhythm is a rhythm rather than a coincidence. */
const MIN_OCCURRENCES = 3;

const DAY_MS = 86_400_000;
const daysBetween = (earlier: IsoDate, later: IsoDate): number =>
  Math.round((Date.parse(later) - Date.parse(earlier)) / DAY_MS);

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};

const medianMinor = (values: readonly bigint[]): bigint => {
  const sorted = [...values].sort((a, b) => (a === b ? 0 : a > b ? 1 : -1));
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0n;
  return ((sorted[middle - 1] ?? 0n) + (sorted[middle] ?? 0n)) / 2n;
};

/** The payee half of a bank's own text, the same field the payee totals group by. */
const payeeOf = (note: string): string => {
  const parts = note.split(" — ");
  return (parts.length > 1 ? parts[1] : parts[0])?.trim() ?? "";
};

const cadenceFor = (gapDays: number): (typeof CADENCES)[number] | undefined =>
  CADENCES.find((entry) => gapDays >= entry.min && gapDays <= entry.max);

/**
 * The payments that arrive on a rhythm: subscriptions, rent, insurance, a loan.
 *
 * Derived rather than declared, because nothing in a bank statement says "this
 * is a standing cost". Three things have to hold together before one is
 * reported: the same payee at least three times, gaps that sit inside one
 * cadence's window, and amounts that barely move. Any one alone is noise -- a
 * payee seen often is a shop, a regular gap with a wandering amount is the
 * weekly shopping, and two identical amounts are a coincidence.
 *
 * Reported as what it costs a year, since that is the figure a person weighs a
 * subscription against, and marked inactive when the last payment is older than
 * its own rhythm explains -- a cancelled service should read as cancelled, not
 * as money still going out.
 */
export const recurringPayments = (args: {
  readonly txns: readonly Txn[];
  readonly rules: readonly SpendingRule[];
  readonly bankAccountIds: ReadonlySet<number>;
  /** Rows that are movements rather than costs -- see spending/internal.ts. */
  readonly excludedIds: ReadonlySet<number>;
  readonly from: IsoDate;
  readonly to: IsoDate;
}): RecurringPayment[] => {
  const byPayee = new Map<
    string,
    { name: string; rows: { date: IsoDate; minor: bigint; note: string }[] }
  >();

  for (const txn of args.txns) {
    if (!args.bankAccountIds.has(txn.accountId)) continue;
    if (args.excludedIds.has(txn.id)) continue;
    if (txn.amount.minor >= 0n) continue;
    if (txn.tradeDate < args.from || txn.tradeDate > args.to) continue;
    const name = payeeOf(txn.note ?? "");
    if (name === "") continue;

    const key = name.toUpperCase();
    const group = byPayee.get(key) ?? { name, rows: [] };
    group.rows.push({ date: txn.tradeDate, minor: -txn.amount.minor, note: txn.note ?? "" });
    byPayee.set(key, group);
  }

  // Carries the sort key alongside, dropped before the caller sees it.
  const found: (RecurringPayment & { readonly annualMinor: bigint })[] = [];

  for (const group of byPayee.values()) {
    if (group.rows.length < MIN_OCCURRENCES) continue;
    const rows = [...group.rows].sort((a, b) => a.date.localeCompare(b.date));

    const gaps = rows
      .slice(1)
      .map((row, index) => daysBetween(rows[index]?.date ?? row.date, row.date));
    const entry = cadenceFor(median(gaps));
    if (entry === undefined) continue;

    const amounts = rows.map((row) => row.minor);
    const typical = medianMinor(amounts);
    if (typical === 0n) continue;
    const wanders = amounts.some((amount) => {
      const drift = amount > typical ? amount - typical : typical - amount;
      return Number(drift) / Number(typical) > AMOUNT_TOLERANCE;
    });
    if (wanders) continue;

    const first = rows[0];
    const last = rows[rows.length - 1];
    if (first === undefined || last === undefined) continue;

    // This payee's own newest row, not whatever else was paid that day.
    const category = categoriseWith(last.note, args.rules);
    const typicalMoney: Money = { minor: typical, currency: EUR };
    const annual: Money = { minor: typical * BigInt(entry.perYear), currency: EUR };

    found.push({
      payee: group.name,
      category,
      categoryLabel: labelForCategory(category),
      cadence: entry.cadence,
      count: rows.length,
      typicalEur: formatMoney(typicalMoney),
      annualEur: formatMoney(annual),
      annualMinor: annual.minor,
      firstDate: first.date,
      lastDate: last.date,
      // One and a half cadences of silence: a payment can be a few days late
      // without the service having been cancelled.
      active: daysBetween(last.date, args.to) <= entry.max * 1.5,
    });
  }

  // Costliest first: the point of the list is deciding what to cancel. Sorted
  // on the minor units rather than the formatted string -- comparing money as
  // floats is the one thing this codebase never does.
  return found
    .sort((a, b) => (a.annualMinor === b.annualMinor ? 0 : a.annualMinor > b.annualMinor ? -1 : 1))
    .map(({ annualMinor: _annualMinor, ...payment }) => payment);
};

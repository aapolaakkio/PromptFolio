import { EUR, formatMoney, type Money } from "../../core/money.ts";
import type { IsoDate, Txn } from "../../core/types.ts";
import { labelForCategory } from "./categories.ts";
import { categoriseWith, type SpendingRule } from "./rules.ts";

type Cadence = "weekly" | "monthly" | "quarterly" | "yearly";

type RecurringPayment = {
  readonly payee: string;
  readonly category: string;
  readonly categoryLabel: string;
  readonly cadence: Cadence;
  readonly count: number;
  readonly typicalEur: string;
  readonly annualEur: string;
  readonly firstDate: IsoDate;
  readonly lastDate: IsoDate;
  readonly active: boolean;
};

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

/** Amount drift allowed: what separates a subscription from the weekly shop, which shares a payee and rhythm but not an amount. */
const AMOUNT_TOLERANCE = 0.15;

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

const payeeOf = (note: string): string => {
  const parts = note.split(" — ");
  return (parts.length > 1 ? parts[1] : parts[0])?.trim() ?? "";
};

const cadenceFor = (gapDays: number): (typeof CADENCES)[number] | undefined =>
  CADENCES.find((entry) => gapDays >= entry.min && gapDays <= entry.max);

/**
 * Payments on a rhythm: subscriptions, rent, insurance, a loan. Derived, since statements do not
 * say "standing cost": same payee at least three times, gaps inside one cadence window, amounts
 * that barely move. Reported per year; inactive when the last payment is older than the rhythm explains.
 */
export const recurringPayments = (args: {
  readonly txns: readonly Txn[];
  readonly rules: readonly SpendingRule[];
  readonly bankAccountIds: ReadonlySet<number>;
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
      // One and a half cadences of silence: a payment may be a few days late.
      active: daysBetween(last.date, args.to) <= entry.max * 1.5,
    });
  }

  // Costliest first, on minor units (money is never compared as floats).
  return found
    .sort((a, b) => (a.annualMinor === b.annualMinor ? 0 : a.annualMinor > b.annualMinor ? -1 : 1))
    .map(({ annualMinor: _annualMinor, ...payment }) => payment);
};

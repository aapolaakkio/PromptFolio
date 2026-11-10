import { addMoney, EUR, zeroMoney, type Money } from "./money.ts";
import { datesBetween } from "./returns.ts";
import type { IsoDate } from "./types.ts";

/** What one debt stood at on a day; owed is a non-negative amount that is subtracted from worth. */
export type DebtBalance = {
  readonly debtId: number;
  readonly asOf: IsoDate;
  readonly owed: Money;
};

const byDate = (a: DebtBalance, b: DebtBalance): number =>
  a.asOf < b.asOf ? -1 : a.asOf > b.asOf ? 1 : 0;

const total = (latest: ReadonlyMap<number, Money>): Money =>
  [...latest.values()].reduce((sum, owed) => addMoney(sum, owed), zeroMoney(EUR));

/** Each debt's latest balance on or before `on`, summed; no arithmetic between balances. */
export const owedOn = (balances: readonly DebtBalance[], on: IsoDate): Money => {
  const latest = new Map<number, Money>();
  for (const balance of balances.toSorted(byDate)) {
    if (balance.asOf > on) break;
    latest.set(balance.debtId, balance.owed);
  }
  return total(latest);
};

/** Daily owed by the rules of `owedOn`, in one pass. */
export const owedSeries = (
  balances: readonly DebtBalance[],
  from: IsoDate,
  to: IsoDate,
): { date: IsoDate; owedEur: Money }[] => {
  const sorted = balances.toSorted(byDate);
  const latest = new Map<number, Money>();
  let next = 0;
  return datesBetween(from, to).map((date) => {
    while (next < sorted.length && sorted[next]!.asOf <= date) {
      latest.set(sorted[next]!.debtId, sorted[next]!.owed);
      next += 1;
    }
    return { date, owedEur: total(latest) };
  });
};

export const firstBalanceDate = (balances: readonly DebtBalance[]): IsoDate | null =>
  balances.toSorted(byDate)[0]?.asOf ?? null;

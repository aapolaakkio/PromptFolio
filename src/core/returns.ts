import {
  addMoney,
  EUR,
  mulMoney,
  toEur,
  zeroMoney,
  type Currency,
  type FxRate,
  type Money,
} from "./money";
import { positionsAt } from "./ledger";
import type { CashFlow, Instrument, IsoDate, Txn } from "./types";

export type ValuePoint = {
  readonly date: IsoDate;
  readonly valueEur: Money;
  readonly stale: boolean;
  /**
   * Instrument ids excluded from `valueEur` on this date because their net position
   * was negative (an unmatched disposal -- see `ledger.ts`'s `negativePositionIds`).
   * Deliberately a distinct field from `stale`: `stale` means "this price is old, not
   * wrong"; an excluded instrument's value is not merely old, it is not included at
   * all, which is a different fact the caller needs to be able to act on separately.
   * Normally empty.
   */
  readonly excludedInstrumentIds: readonly number[];
};

/**
 * `priceOn`/`fxOn` return the last known value on or before `date`, or `null` if none
 * exists yet. Because that lookup alone cannot distinguish a fresh price from a
 * carried-forward one, `priceDateOn` reports the date the returned price is actually
 * dated — staleness is `priceDateOn(...) !== date`.
 */
export type PriceLookup = {
  priceOn(instrumentId: number, date: IsoDate): Money | null;
  priceDateOn(instrumentId: number, date: IsoDate): IsoDate | null;
  fxOn(currency: Currency, date: IsoDate): FxRate | null;
};

const DAY_MS = 86_400_000;

export const datesBetween = (from: IsoDate, to: IsoDate): IsoDate[] => {
  const out: IsoDate[] = [];
  for (let t = Date.parse(from); t <= Date.parse(to); t += DAY_MS) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
};

/**
 * Fractional years between two dates, ACT/ACT (ISDA) style: whole years are counted
 * by calendar anniversary, and the leftover fraction is the leftover days divided by
 * the length in days of *that* anniversary year. This makes a span of exact calendar
 * years (e.g. 2024-01-01 to 2025-01-01) come out to exactly 1.0 regardless of whether
 * a leap day falls inside it — unlike dividing raw elapsed days by a fixed 365 or
 * 365.25, which both introduce error XIRR's precision requirements can't absorb.
 */
const yearsBetween = (a: IsoDate, b: IsoDate): number => {
  const start = new Date(`${a}T00:00:00.000Z`);
  const end = new Date(`${b}T00:00:00.000Z`);
  let years = end.getUTCFullYear() - start.getUTCFullYear();
  const anniversary = (offset: number): Date =>
    new Date(Date.UTC(start.getUTCFullYear() + offset, start.getUTCMonth(), start.getUTCDate()));
  if (anniversary(years).getTime() > end.getTime()) years -= 1;
  const periodStart = anniversary(years);
  const periodEnd = anniversary(years + 1);
  const fraction =
    (end.getTime() - periodStart.getTime()) / (periodEnd.getTime() - periodStart.getTime());
  return years + fraction;
};

/**
 * Daily EUR value of all positions. A day is `stale` when any held instrument's
 * price was not dated that exact day (i.e. it was carried forward from an earlier date).
 */
export const valueSeries = (
  txns: readonly Txn[],
  instruments: readonly Instrument[],
  prices: PriceLookup,
  from: IsoDate,
  to: IsoDate,
): ValuePoint[] => {
  const byId = new Map(instruments.map((i) => [i.id, i]));
  return datesBetween(from, to).map((date) => {
    let value = zeroMoney(EUR);
    let stale = false;
    const excludedInstrumentIds: number[] = [];
    for (const [instrumentId, qty] of positionsAt(txns, date)) {
      const instrument = byId.get(instrumentId);
      if (!instrument) continue;
      // A negative quantity is an unmatched disposal, not a real short position --
      // multiplying it by a price would drag the total down by a fabricated negative
      // amount. Excluded from the sum, but recorded here rather than silently
      // dropped, so the caller knows this day's value is missing that instrument.
      if (qty.scaled < 0n) {
        excludedInstrumentIds.push(instrumentId);
        continue;
      }
      const price = prices.priceOn(instrumentId, date);
      if (price === null) {
        stale = true;
        continue;
      }
      if (prices.priceDateOn(instrumentId, date) !== date) stale = true;
      const native = mulMoney(price, qty, "half-up");
      if (instrument.currency === EUR) {
        value = addMoney(value, native);
        continue;
      }
      const rate = prices.fxOn(instrument.currency, date);
      if (rate === null) {
        stale = true;
        continue;
      }
      value = addMoney(value, toEur(native, rate, "half-up"));
    }
    return { date, valueEur: value, stale, excludedInstrumentIds };
  });
};

/**
 * Converts a `Money` to a plain ratio input for the rate maths below. Rates of return
 * are the only `number`s in `core`; this conversion must never be used to build an amount.
 */
const toNumber = (m: Money): number => Number(m.minor) / 100;

/** Money-weighted return. `flows` are contributions (negative) and withdrawals (positive). */
export const xirr = (flows: readonly CashFlow[], finalValue: CashFlow): number => {
  const all = [...flows, finalValue];
  if (all.length < 2) throw new Error("xirr needs at least two cash flows");
  const amounts = all.map((f) => toNumber(f.amountEur));
  if (!(amounts.some((a) => a > 0) && amounts.some((a) => a < 0))) {
    throw new Error("xirr requires cash flows of both signs");
  }
  const t0 = all[0]!.date;
  const years = all.map((f) => yearsBetween(t0, f.date));

  const npv = (rate: number): number =>
    amounts.reduce((sum, a, i) => sum + a / Math.pow(1 + rate, years[i]!), 0);

  // Newton-Raphson, with bisection as the fallback when it fails to converge
  // (diverges outside the domain, stalls on a zero derivative, or simply
  // doesn't settle within the iteration budget).
  let rate = 0.1;
  for (let i = 0; i < 60; i++) {
    const f = npv(rate);
    if (Math.abs(f) < 1e-9) return rate;
    const derivative = amounts.reduce(
      (sum, a, i2) => sum - (years[i2]! * a) / Math.pow(1 + rate, years[i2]! + 1),
      0,
    );
    if (derivative === 0) break;
    const next = rate - f / derivative;
    if (!Number.isFinite(next) || next <= -0.999999) break;
    if (Math.abs(next - rate) < 1e-12) return next;
    rate = next;
  }

  let low = -0.9999;
  let high = 100;
  if (npv(low) * npv(high) > 0) throw new Error("xirr failed to bracket a root");
  for (let i = 0; i < 400; i++) {
    const mid = (low + high) / 2;
    if (npv(low) * npv(mid) <= 0) high = mid;
    else low = mid;
  }
  return (low + high) / 2;
};

/**
 * Time-weighted return: chain sub-period returns, neutralising the timing of external flows.
 *
 * Convention: a flow dated the same day as a valuation is treated as arriving AFTER that
 * valuation was taken, so it becomes part of the *next* sub-period's starting base rather
 * than distorting the sub-period that just ended. This is verified against the brief's
 * worked example — values 1000.00 (2024-01-01) -> 1400.00 (2024-07-01) -> 3360.00
 * (2024-12-31) with a 1000.00 deposit dated 2024-07-01:
 *   sub-period 1: start = 1000 (no flow on 2024-01-01), end = 1400 -> return 0.40
 *   sub-period 2: start = 1400 + 1000 (the 2024-07-01 deposit) = 2400, end = 3360 -> return 0.40
 *   chained = 1.40 * 1.40 - 1 = 0.96
 * The opposite convention (netting the flow out of the 1400 ending value instead) chains to
 * 2.36, which the "twr ignores the timing of deposits" test rejects.
 */
export const twr = (values: readonly ValuePoint[], flows: readonly CashFlow[]): number => {
  if (values.length < 2) return 0;
  const flowsByDate = new Map<IsoDate, number>();
  for (const f of flows) {
    flowsByDate.set(f.date, (flowsByDate.get(f.date) ?? 0) + toNumber(f.amountEur));
  }

  let chained = 1;
  for (let i = 1; i < values.length; i++) {
    const startPoint = values[i - 1]!;
    const endPoint = values[i]!;
    const start = toNumber(startPoint.valueEur) + (flowsByDate.get(startPoint.date) ?? 0);
    const end = toNumber(endPoint.valueEur);
    if (start === 0) continue;
    chained *= end / start;
  }
  return chained - 1;
};

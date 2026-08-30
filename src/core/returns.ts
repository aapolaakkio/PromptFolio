import {
  addMoney,
  EUR,
  mulMoney,
  toEur,
  zeroMoney,
  type Currency,
  type FxRate,
  type Money,
  type Quantity,
} from "./money.ts";
import { costBasisAt } from "./costbasis.ts";
import { investedCashFlows, positionsAt } from "./ledger.ts";
import type { CashFlow, Instrument, IsoDate, Txn } from "./types.ts";

export type ValuePoint = {
  readonly date: IsoDate;
  readonly valueEur: Money;
  readonly stale: boolean;
  /**
   * Instruments left out of `valueEur` because they could not honestly be valued:
   * a negative net position, no price for the date, or no fx rate for it.
   *
   * Distinct from `stale`, which means a value was computed from an old price.
   * An excluded holding is not in the total at all, and the caller must show it
   * as unvalued rather than folding in an implied zero. Normally empty.
   */
  readonly excludedInstrumentIds: readonly number[];
  /**
   * Instruments valued at their cost basis on this day, because no price exists
   * for them yet. Reported so `twr` can skip the sub-period in which one starts
   * or stops being measured that way -- the jump then is a change of measuring
   * stick, not a return.
   */
  readonly costValuedInstrumentIds: readonly number[];
};

/**
 * `priceOn`/`fxOn` give the last known value on or before `date`. That alone cannot
 * tell a fresh price from a carried-forward one, so `priceDateOn` reports what the
 * returned price is dated: staleness is `priceDateOn(...) !== date`.
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
 * Fractional years, ACT/ACT (ISDA): whole years by calendar anniversary, the rest as
 * days over the length of that anniversary year. An exact calendar year comes out at
 * 1.0 whether or not a leap day falls inside it, which a fixed 365 or 365.25 cannot
 * manage to XIRR's precision.
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
 * Daily EUR value of all positions. A day is stale when a price was carried forward
 * rather than dated that day, or when a holding could not be valued at all.
 */
export const valueSeries = (
  txns: readonly Txn[],
  instruments: readonly Instrument[],
  prices: PriceLookup,
  from: IsoDate,
  to: IsoDate,
): ValuePoint[] => {
  const byId = new Map(instruments.map((i) => [i.id, i]));

  /**
   * Every split, with the counts before and after it. Price history arrives
   * split-adjusted while the ledger keeps the raw counts held, so multiplying one
   * by the other valued pre-split shares at post-split prices -- a hundredfold
   * overstatement for a 1:100 reverse split, vanishing on the split date and
   * reading as a huge one-day loss.
   */
  const splitsByInstrument = new Map<
    number,
    Array<{ date: IsoDate; after: bigint; before: bigint }>
  >();
  for (const t of txns) {
    if (t.type !== "SPLIT" || t.instrumentId === null) continue;
    const before = positionsAt(
      txns.filter((other) => other.tradeDate < t.tradeDate),
      t.tradeDate,
    ).get(t.instrumentId);
    if (before === undefined || before.scaled <= 0n || t.quantity.scaled <= 0n) continue;
    const list = splitsByInstrument.get(t.instrumentId) ?? [];
    list.push({ date: t.tradeDate, after: t.quantity.scaled, before: before.scaled });
    splitsByInstrument.set(t.instrumentId, list);
  }

  /**
   * A held quantity restated in the price series' own terms: scaled by every split
   * still ahead of `date`, so a pre-split holding is valued as the post-split
   * shares it became. Exact bigint arithmetic, half-up on the remainder, matching
   * the rounding `core/money.ts` applies everywhere else.
   */
  const asPricedQuantity = (instrumentId: number, qty: Quantity, date: IsoDate): Quantity => {
    const splits = splitsByInstrument.get(instrumentId);
    if (splits === undefined) return qty;
    let numerator = qty.scaled;
    let denominator = 1n;
    for (const split of splits) {
      if (split.date <= date) continue;
      numerator *= split.after;
      denominator *= split.before;
    }
    if (denominator === 1n) return qty;
    const quotient = numerator / denominator;
    const remainder = numerator % denominator;
    return { scaled: remainder * 2n >= denominator ? quotient + 1n : quotient };
  };

  /**
   * Cost basis per instrument on a date, for holdings that have no price yet.
   * Built only when that happens and memoised per date: a full ledger has
   * thousands of dates and almost all of them price everything they hold.
   */
  const costCache = new Map<IsoDate, Map<number, Money>>();
  const costOn = (instrumentId: number, date: IsoDate): Money | null => {
    let byInstrument = costCache.get(date);
    if (byInstrument === undefined) {
      try {
        byInstrument = costBasisAt(txns, date);
      } catch {
        // An unmatched disposal somewhere in the ledger: the holding stays
        // excluded rather than valued from a basis that could not be built.
        byInstrument = new Map<number, Money>();
      }
      costCache.set(date, byInstrument);
    }
    return byInstrument.get(instrumentId) ?? null;
  };

  return datesBetween(from, to).map((date) => {
    let value = zeroMoney(EUR);
    let stale = false;
    const excludedInstrumentIds: number[] = [];
    const costValuedInstrumentIds: number[] = [];
    for (const [instrumentId, qty] of positionsAt(txns, date)) {
      const instrument = byId.get(instrumentId);
      if (!instrument) continue;
      // A negative quantity is an unmatched disposal, not a short position: priced,
      // it would drag the total down by a fabricated amount. Recorded rather than
      // dropped, so the caller knows the day is missing an instrument.
      if (qty.scaled < 0n) {
        // Missing a real holding, like the branches below: same signal, not a
        // clean-looking number with an exclusion nobody was told to distrust.
        stale = true;
        excludedInstrumentIds.push(instrumentId);
        continue;
      }
      const price = prices.priceOn(instrumentId, date);
      if (price === null) {
        // No price at all, not even a carried-forward one, so this is before the
        // instrument's first: a subscription bought before listing, a delisted
        // holding, a fund whose provider serves only recent history. Cost
        // understates movement but never invents any; excluding it instead dropped
        // a real position out of the portfolio and made twr skip every day it was
        // held, which on a real ledger drove the figure to null.
        const cost = costOn(instrumentId, date);
        if (cost === null) {
          stale = true;
          excludedInstrumentIds.push(instrumentId);
          continue;
        }
        // Cost basis is already EUR, so no rate is needed. `stale` still marks the
        // day as not built from live prices.
        stale = true;
        costValuedInstrumentIds.push(instrumentId);
        value = addMoney(value, cost);
        continue;
      }
      if (prices.priceDateOn(instrumentId, date) !== date) stale = true;
      const native = mulMoney(price, asPricedQuantity(instrumentId, qty, date), "half-up");
      if (instrument.currency === EUR) {
        value = addMoney(value, native);
        continue;
      }
      const rate = prices.fxOn(instrument.currency, date);
      if (rate === null) {
        // A dated price but no fx rate. Never fall through unconverted or as an
        // implied zero: excluded exactly like a missing price.
        stale = true;
        excludedInstrumentIds.push(instrumentId);
        continue;
      }
      value = addMoney(value, toEur(native, rate, "half-up"));
    }
    return { date, valueEur: value, stale, excludedInstrumentIds, costValuedInstrumentIds };
  });
};

/** For the rate maths only. Rates are the only numbers in core; never build an amount from this. */
const toNumber = (m: Money): number => Number(m.minor) / 100;

/** True when both lists name the same instruments, order aside. */
const sameInstrumentSet = (a: readonly number[], b: readonly number[]): boolean => {
  if (a.length !== b.length) return false;
  const seen = new Set(a);
  return b.every((id) => seen.has(id));
};

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

  // Newton-Raphson, falling back to bisection when it will not converge.
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
 * Time-weighted return: chained sub-period returns, neutralising the timing of flows.
 *
 * `flows` must describe the same portfolio `values` measures, or this computes the
 * return of two different things. `values` prices positions only, so the only flow
 * that changes it is a trade: pass `investedCashFlows`, never `externalCashFlows`
 * (that one is deposit-shaped and belongs to `xirr`).
 *
 * Same-day convention: `valueSeries(D)` already includes a trade dated `D`, so a flow
 * dated `D` is subtracted back out of the day's value before comparing it to the
 * previous base -- otherwise the capital it added counts twice, once as the base
 * growing and again as the market growing it.
 *
 * A sub-period is skipped rather than chained when it cannot be trusted:
 *
 *   - a zero start, because a deposit that has not funded a purchase yet has no base
 *     to measure against, and `0 / something` poisons every later factor;
 *   - either endpoint carrying an exclusion, because the missing holding's value makes
 *     the comparison fabricated -- a low end reads as a loss down to -100%, a low start
 *     as a gain out of nowhere;
 *   - a holding changing between cost-valued and priced, because the jump then is a
 *     change of measuring stick, not a return.
 *
 * Skipping a handful is honest; skipping most of them is not. A holding left unpriced
 * for months skips every sub-period touching it, and with it every other holding's real
 * return across that stretch -- a much shorter measurement wearing the original's label.
 * So once exclusion-driven skips are the majority, this returns null: the same honest
 * unknown `xirr` gives rather than a precise-looking number computed from a fraction of
 * the window it claims.
 */
export const twr = (values: readonly ValuePoint[], flows: readonly CashFlow[]): number | null => {
  if (values.length < 2) return 0;
  const flowsByDate = new Map<IsoDate, number>();
  for (const f of flows) {
    flowsByDate.set(f.date, (flowsByDate.get(f.date) ?? 0) + toNumber(f.amountEur));
  }

  let chained = 1;
  let contributed = 0;
  let excludedSkips = 0;
  for (let i = 1; i < values.length; i++) {
    const startPoint = values[i - 1]!;
    const endPoint = values[i]!;
    const start = toNumber(startPoint.valueEur);
    // No base to measure against yet -- see this function's doc.
    if (start === 0) continue;
    // Counted separately from the zero-start case, so the majority check below can
    // tell a real gap in the data from the zero every ledger starts with.
    if (startPoint.excludedInstrumentIds.length > 0 || endPoint.excludedInstrumentIds.length > 0) {
      excludedSkips++;
      continue;
    }
    // Months of movement land in one sub-period the day a holding stops being
    // valued at cost. A change of measuring stick, not a return.
    if (!sameInstrumentSet(startPoint.costValuedInstrumentIds, endPoint.costValuedInstrumentIds)) {
      excludedSkips++;
      continue;
    }
    // Subtracted back out so capital invested that day is not read as growth.
    const end = toNumber(endPoint.valueEur) - (flowsByDate.get(endPoint.date) ?? 0);
    chained *= end / start;
    contributed++;
  }

  // A minority sample of the window is reported unknown, not as a rate.
  if (excludedSkips > 0 && excludedSkips >= contributed) return null;

  return chained - 1;
};

/** One day's invested capital: what has been put into holdings, net of what has been taken out. */
export type InvestedPoint = { readonly date: IsoDate; readonly investedEur: Money };

/**
 * What the owner has put into their holdings, day by day.
 *
 * The counterpart to `valueSeries`: drawn together, the gap between the two is
 * the return, and it is the one picture that makes a percentage feel like
 * money. A rising value line above a flat invested line is growth; the same
 * value line above an equally rising invested line is only deposits.
 *
 * Built from `investedCashFlows`, the same flows XIRR uses, so the two cannot
 * disagree about what counts as invested. A sale reduces it: the money came
 * back out, whether or not it was spent.
 */
export const investedSeries = (
  txns: readonly Txn[],
  from: IsoDate,
  to: IsoDate,
): InvestedPoint[] => {
  const flows = investedCashFlows(txns);
  let running = zeroMoney(EUR);
  let next = 0;

  return datesBetween(from, to).map((date) => {
    while (next < flows.length && flows[next]!.date <= date) {
      running = addMoney(running, flows[next]!.amountEur);
      next += 1;
    }
    return { date, investedEur: running };
  });
};

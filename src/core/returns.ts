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
import { isPriceStale } from "./staleness.ts";
import type { CashFlow, Instrument, IsoDate, Txn } from "./types.ts";

type ValuePoint = {
  readonly date: IsoDate;
  readonly valueEur: Money;
  readonly stale: boolean;
  /** Left out of `valueEur`: negative position, no price, or no fx rate. Show as unvalued, not zero. */
  readonly excludedInstrumentIds: readonly number[];
  /** Valued at cost basis because no price exists yet; `twr` skips the sub-period where this changes. */
  readonly costValuedInstrumentIds: readonly number[];
};

/** `priceOn`/`fxOn` carry the last known value forward; a day is stale when a price is older than `isPriceStale` allows. */
// Function properties, not methods: callers pass `prices.fxOn` around unbound.
export type PriceLookup = {
  priceOn: (instrumentId: number, date: IsoDate) => Money | null;
  priceDateOn: (instrumentId: number, date: IsoDate) => IsoDate | null;
  fxOn: (currency: Currency, date: IsoDate) => FxRate | null;
};

const DAY_MS = 86_400_000;

export const datesBetween = (from: IsoDate, to: IsoDate): IsoDate[] => {
  const out: IsoDate[] = [];
  for (let t = Date.parse(from); t <= Date.parse(to); t += DAY_MS) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
};

/** ACT/ACT (ISDA) fractional years: an exact calendar year is 1.0 even across a leap day. */
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

/** Daily EUR value of all positions. Stale: a carried-forward price or an unvalued holding. */
export const valueSeries = (
  txns: readonly Txn[],
  instruments: readonly Instrument[],
  prices: PriceLookup,
  from: IsoDate,
  to: IsoDate,
): ValuePoint[] => {
  const byId = new Map(instruments.map((i) => [i.id, i]));

  // Price history is split-adjusted but the ledger keeps raw counts, so pre-split
  // holdings must be restated or they are valued at post-split prices.
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

  // Scales by every split after `date`; bigint, half-up like money.ts.
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

  // Lazy and memoised per date: almost every date prices everything it holds.
  const costCache = new Map<IsoDate, Map<number, Money>>();
  const costOn = (instrumentId: number, date: IsoDate): Money | null => {
    let byInstrument = costCache.get(date);
    if (byInstrument === undefined) {
      try {
        byInstrument = costBasisAt(txns, date);
      } catch {
        // Unmatched disposal: stay excluded rather than use an unbuildable basis.
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
      // Negative means an unmatched disposal, not a short: pricing it would fabricate a loss.
      if (qty.scaled < 0n) {
        stale = true;
        excludedInstrumentIds.push(instrumentId);
        continue;
      }
      const price = prices.priceOn(instrumentId, date);
      if (price === null) {
        // Before the first price (pre-listing buy, delisted, short history): cost
        // understates movement but never invents it; excluding made twr null.
        const cost = costOn(instrumentId, date);
        if (cost === null) {
          stale = true;
          excludedInstrumentIds.push(instrumentId);
          continue;
        }
        stale = true;
        costValuedInstrumentIds.push(instrumentId);
        value = addMoney(value, cost);
        continue;
      }
      // Same rule as the holdings badge: a weekend's Friday close and a fund's previous-weekday NAV are current.
      const priceDate = prices.priceDateOn(instrumentId, date);
      if (isPriceStale({ kind: instrument.kind, priceDate, on: date })) stale = true;
      const native = mulMoney(price, asPricedQuantity(instrumentId, qty, date), "half-up");
      if (instrument.currency === EUR) {
        value = addMoney(value, native);
        continue;
      }
      const rate = prices.fxOn(instrument.currency, date);
      if (rate === null) {
        // Price without fx: exclude, never use unconverted.
        stale = true;
        excludedInstrumentIds.push(instrumentId);
        continue;
      }
      value = addMoney(value, toEur(native, rate, "half-up"));
    }
    return { date, valueEur: value, stale, excludedInstrumentIds, costValuedInstrumentIds };
  });
};

/** Rate maths only; never build an amount from this. */
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
 * Time-weighted return. `flows` must be `investedCashFlows` (trades), not `externalCashFlows`.
 * A flow dated D is subtracted from D's value, since valueSeries(D) already includes that trade.
 * Skipped sub-periods: zero start, an excluded holding at either end, or a holding switching
 * between cost-valued and priced. Returns null once such skips are the majority.
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
    if (start === 0) continue;
    // Counted apart from zero starts: those are normal, these are data gaps.
    if (startPoint.excludedInstrumentIds.length > 0 || endPoint.excludedInstrumentIds.length > 0) {
      excludedSkips++;
      continue;
    }
    if (!sameInstrumentSet(startPoint.costValuedInstrumentIds, endPoint.costValuedInstrumentIds)) {
      excludedSkips++;
      continue;
    }
    const end = toNumber(endPoint.valueEur) - (flowsByDate.get(endPoint.date) ?? 0);
    chained *= end / start;
    contributed++;
  }

  if (excludedSkips > 0 && excludedSkips >= contributed) return null;

  return chained - 1;
};

/** One day's invested capital: what has been put into holdings, net of what has been taken out. */
type InvestedPoint = { readonly date: IsoDate; readonly investedEur: Money };

/** Running invested capital from `investedCashFlows` (same as XIRR); a sale reduces it. */
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

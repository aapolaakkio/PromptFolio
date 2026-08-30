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
} from "./money";
import { costBasisAt } from "./costbasis";
import { investedCashFlows, positionsAt } from "./ledger";
import type { CashFlow, Instrument, IsoDate, Txn } from "./types";

export type ValuePoint = {
  readonly date: IsoDate;
  readonly valueEur: Money;
  readonly stale: boolean;
  /**
   * Instrument ids excluded from `valueEur` on this date because it could not honestly
   * be valued, for any of three reasons: (1) their net position was negative (an
   * unmatched disposal -- see `ledger.ts`'s `negativePositionIds`), (2) no price is
   * known for this date, or (3) the instrument prices in a non-EUR currency with no fx
   * rate known for this date. Deliberately a distinct field from `stale`: `stale` means
   * "a price used here is old, not wrong" (a value was still computed); an excluded
   * instrument's value is not merely old, it is not included in `valueEur` at all --
   * a different fact the caller needs to act on separately (C1: the caller must show
   * this holding as unvalued, never silently fold it into the total as an implied
   * 0,00 €). Normally empty.
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
 * price was not dated that exact day (i.e. it was carried forward from an earlier date),
 * or when a held instrument could not be valued at all (see `ValuePoint.excludedInstrumentIds`'s
 * doc) -- either way the number shown must carry a badge, not read as clean.
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
   * Every split, with the share count immediately before it and the count it
   * produced. Price history is served split-adjusted -- a provider quotes a share at
   * a hundred times its raw price of the day, because it states
   * the whole series in post-split terms -- while the ledger keeps the raw counts
   * actually held. Multiplying one by the other valued pre-split shares at
   * post-split prices -- for a 1:100 reverse split, a hundredfold overstatement --
   * which vanished on the split date and read as a large one-day portfolio loss.
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
      // A negative quantity is an unmatched disposal, not a real short position --
      // multiplying it by a price would drag the total down by a fabricated negative
      // amount. Excluded from the sum, but recorded here rather than silently
      // dropped, so the caller knows this day's value is missing that instrument.
      if (qty.scaled < 0n) {
        // C5 fix: this day's value is missing a real holding (see the doc above), exactly
        // like the missing-price and missing-fx branches below -- it must carry the same
        // `stale` signal they do, not a silent "clean" number with an exclusion nobody
        // told the caller to distrust.
        stale = true;
        excludedInstrumentIds.push(instrumentId);
        continue;
      }
      const price = prices.priceOn(instrumentId, date);
      if (price === null) {
        // No price at all for this date -- not even an older, carried-forward one --
        // so this is necessarily *before* the instrument's first known price. Three
        // real cases produce it, and cost is the honest value for all three: a
        // subscription bought before its share listed (an IPO, where the price paid
        // IS the value), a delisted or merged-away holding no source will ever carry,
        // and a fund whose provider serves only a few years of history. Holding it at
        // cost understates movement but never invents any; excluding it instead
        // dropped a real position out of the portfolio's value entirely and made
        // `twr` skip every day it was held. On a real ledger the unpriceable
        // sub-periods just outnumbered the usable ones, which drove the whole
        // figure to null.
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
        // C1: a real, dated price exists, but no fx rate does -- e.g. a EUR-booked,
        // SEK-quoted holding before `fx.ts`'s currency sourcing fix (§10a A2/A5). This
        // must never fall through to `value` unconverted or as an implied 0,00 €;
        // excluded exactly like a missing price, for the same reason.
        stale = true;
        excludedInstrumentIds.push(instrumentId);
        continue;
      }
      value = addMoney(value, toEur(native, rate, "half-up"));
    }
    return { date, valueEur: value, stale, excludedInstrumentIds, costValuedInstrumentIds };
  });
};

/**
 * Converts a `Money` to a plain ratio input for the rate maths below. Rates of return
 * are the only `number`s in `core`; this conversion must never be used to build an amount.
 */
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
 * C4 fix (2026-08-28) -- `flows` MUST describe the same portfolio `values` measures, or this
 * function silently computes the return of two different things. `values` comes from
 * `valueSeries`, which prices *positions only* -- quantity x price x FX (spec §7) -- and
 * deliberately excludes uninvested cash. The only flow that changes what `valueSeries` prices
 * is a trade: a BUY adds units, a SELL removes them. A bank deposit that has not yet been
 * invested changes the cash account, which `valueSeries` never looks at, so it is NOT a flow
 * into the thing being measured here. Callers must pass `core/ledger.ts`'s
 * `investedCashFlows(txns)`, never `externalCashFlows(txns)` (that one is deposit/withdrawal
 * -shaped and belongs to `xirr`, which legitimately measures the investor's own cash timing).
 * If you are about to change what `flows` means here, re-read `investedCashFlows`'s doc first
 * -- this pairing is the whole fix for a defect that shipped as "TWR is systematically wrong
 * for any portfolio that deposits and invests" and must not be re-introduced by only one side
 * changing.
 *
 * Same-day convention -- the flip side of that pairing: `valueSeries(D)` already includes any
 * trade dated exactly `D` (`positionsAt` uses `tradeDate <= D`), so a flow dated `D` is NOT
 * "about to happen" relative to `values`'s point for `D` -- it already happened, and the
 * measured value already reflects it. So, unlike a deposit that lands in cash and waits, a
 * trade-flow must be subtracted back OUT of the day's value before comparing it to the
 * previous sub-period's base, or the capital it added gets counted twice: once as "the base
 * grew" and again as "the base grew *because the market grew it*". Concretely, for the pair
 * (values[i-1], values[i]), the sub-period factor is:
 *
 *   (values[i].valueEur - flowsDatedAt(values[i].date)) / values[i-1].valueEur
 *
 * Worked example (single deposit, invested same day, position then gains 25%): values
 * 8000.00 (2024-01-01, the day of the BUY) -> 10000.00 (2025-01-01, no further flows).
 * flow on 2024-01-01 = +8000.00 (the BUY, via `investedCashFlows`). That flow lands on
 * `values[0]`'s own date, which -- like every ledger's very first purchase -- is never the
 * *end* of any sub-period, so it is never subtracted from anything; it is simply the base
 * the first computable sub-period starts from. The one sub-period here: (10000.00 - 0) /
 * 8000.00 = 1.25 -> +25%, matching the position's actual 80.00 -> 100.00 move exactly, with
 * no distortion from the deposit that funded it.
 *
 * Second worked example (three flat-price monthly deposits, each fully invested same day):
 * values 1000/2000/3000/3000 on 2024-01-01/02-01/03-01/04-01, flows +1000 on each of the
 * first three dates. Sub-periods: (2000-1000)/1000 = 1.0, (3000-1000)/2000 = 1.0,
 * (3000-0)/3000 = 1.0 -> chained 1.0, TWR = 0, correctly flat despite three deposits.
 *
 * C3 (2026-08-27, still in force): a sub-period's *start* can legitimately be zero -- e.g. a
 * deposit dated today has not yet funded a purchase, so `values` stays 0 until the BUY lands.
 * There is no base to compute a return against, so that sub-period contributes no factor at
 * all (skipped), rather than the `0 / something` that used to poison every later sub-period
 * too via the running product. This is not a rare edge case: every ledger's very first
 * deposit necessarily predates its very first purchase by at least the time it takes to place
 * the order.
 *
 * C5 fix (2026-08-28) -- the other half of C3 that was missing: a `ValuePoint` can also be
 * incomplete for a reason that has nothing to do with "no capital yet" -- `values[i]` can
 * carry a non-empty `excludedInstrumentIds` (an unpriceable holding, an unconvertible
 * currency, or an unmatched disposal -- see `ValuePoint`'s own doc). Unlike a genuine zero
 * start, `valueEur` there is not "correctly small", it is *wrong* -- a real position's worth
 * is simply missing from it. Two ways that corrupts a naive comparison:
 *
 *   - If `endPoint` is excluded but `startPoint` was not, `end` is artificially low (the
 *     missing holding's value vanished from the numerator) -- comparing it to a full `start`
 *     fabricates a loss, up to and including the -100% this fix was written for (the
 *     exact repro: a second, never-priced holding collapses a flat two-holding portfolio to
 *     `end = 0`).
 *   - If `startPoint` is excluded but `endPoint` is not (the missing price finally arrives),
 *     the reverse happens: `start` is artificially low, so the holding's entire value
 *     re-appearing reads as a fabricated gain out of nowhere.
 *
 * Either shape is a `0`-or-poisoned factor in the same family C3 already guards against, so
 * this sub-period is skipped exactly the same way: neither `startPoint` nor `endPoint` may
 * carry an exclusion for this factor to be trusted.
 *
 * **Skip vs. null.** Skipping a handful of sub-periods (a fund unpriced for one bad night, a
 * paged import mid-commit) is honest: every *other* transition in the series is still a real,
 * uncorrupted comparison, and the chained product still reflects the portfolio's real
 * performance minus a few silently-bridged gaps -- the same trade-off C3 already accepts for
 * a not-yet-invested deposit. But an exclusion that persists for a long run of consecutive
 * days (the documented case: an S-Pankki/Danske fund left on `manual` for months before its
 * first price, or a Nordnet fund held for a year before the nightly refresh job existed) skips
 * *every* sub-period touching it -- which, because each transition compares only to its
 * immediate neighbour, also silently discards every OTHER holding's real, fully-priced return
 * across that entire stretch, not just the broken holding's. A chained result built from a
 * small minority of the requested window is not "the TWR, minus a rounding footnote" -- it is
 * a different, much shorter measurement wearing the original one's label, which is exactly the
 * "confident wrong number" this whole fix exists to stop producing. So: once exclusion-driven
 * skips are the majority of the sub-periods that would otherwise have contributed a factor,
 * this returns `null` -- the same "honest unknown" `xirr` already returns rather than a
 * fabricated rate -- instead of a number that looks precise but was computed from a fraction
 * of the history it claims to describe. The `/api/returns` caller pairs this with
 * `excludedInstrumentIds` (see that route) so the UI can say *which* holding broke the
 * calculation, not just show an unexplained dash.
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
    // No capital was actually invested yet at the start of this sub-period -- e.g. a
    // deposit dated today has not yet funded a purchase. There is no base to compute a
    // return against, so this sub-period contributes nothing to the chain (C3), rather
    // than a corrupting `0` factor that poisons every later sub-period in the product.
    if (start === 0) continue;
    // C5: either endpoint missing a real holding's value makes this comparison
    // fabricated, not merely imprecise (see this function's doc) -- skip it exactly
    // like the zero-start case above, but count it separately so the majority check
    // below can tell "a real gap in the data" apart from "the normal pre-investment
    // zero every ledger starts with".
    if (startPoint.excludedInstrumentIds.length > 0 || endPoint.excludedInstrumentIds.length > 0) {
      excludedSkips++;
      continue;
    }
    // The day a holding stops being valued at cost and starts being valued at a
    // market price, its contribution to the total jumps by however much it moved
    // while unpriced -- months or years of it, landing in one sub-period. That is
    // a change of measuring stick, not a day's return, so the sub-period spanning
    // it is skipped exactly like one missing a holding outright. The same applies
    // in reverse, and to a holding transferred from a cost-valued instrument into
    // a priced one (a share swap out of a temporary corporate-action line).
    if (!sameInstrumentSet(startPoint.costValuedInstrumentIds, endPoint.costValuedInstrumentIds)) {
      excludedSkips++;
      continue;
    }
    // The end value already includes any trade dated exactly on `endPoint.date` (see this
    // function's doc) -- subtract it back out so freshly-invested capital is not counted
    // as market growth in the very sub-period it arrived.
    const end = toNumber(endPoint.valueEur) - (flowsByDate.get(endPoint.date) ?? 0);
    chained *= end / start;
    contributed++;
  }

  // C5: exclusion-driven skips outnumbering (or matching) the sub-periods that actually
  // fed the product means what is left is a minority sample of the requested window --
  // see this function's doc for why that is reported as unknown rather than as a real,
  // precise-looking rate.
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

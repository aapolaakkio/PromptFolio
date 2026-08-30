import { addMoney, EUR, mulMoney, toEur, zeroMoney, type Money, type Quantity } from "./money.ts";
import { positionsAt } from "./ledger.ts";
import type { PriceLookup } from "./returns.ts";
import type { ValuedCash } from "./cash.ts";
import type { Instrument, IsoDate, Txn } from "./types.ts";

export type Dimension = "kind" | "currency" | "account" | "instrument";

export type Slice = {
  readonly key: string;
  readonly label: string;
  readonly valueEur: Money;
  readonly weight: number;
};

export type AllocationResult = {
  readonly slices: Slice[];
  /**
   * Instrument ids held with a positive quantity at `on` but left out of every slice
   * because no price was known for `on`, or (for a non-EUR instrument) no fx rate was
   * known for `on` -- C1: these used to just vanish from the response with no trace,
   * indistinguishable from "not held" or "genuinely worth nothing". Mirrors
   * `returns.ts`'s `ValuePoint.excludedInstrumentIds` in shape and purpose.
   *
   * Deliberately does NOT include a negative-position (unmatched-disposal) exclusion --
   * `ledger.ts`'s `negativePositionIds`, computed over the *whole* ledger, already
   * covers that case; this function only ever sees one account's transactions at a
   * time (see `buckets` below), so an instrument negative in one account but positive
   * overall would be misreported here. Callers combine both lists (see
   * `server/api/portfolio.ts`'s `/api/allocation`).
   */
  readonly excludedInstrumentIds: readonly number[];
};

const KIND_LABELS = {
  stock: "Osakkeet",
  etf: "ETF:t",
  fund: "Rahastot",
  cash: "Käteinen",
} satisfies Record<Instrument["kind"], string>;

/**
 * Which slice an instrument held in an account falls into.
 *
 * Exported because a caller that acts on a slice -- a rebalance plan proposing
 * to sell 1 000 € "of funds" -- has to know which holdings that names before it
 * can say what the sale would realise. Deriving it a second time in the caller
 * would let the two disagree about what a slice contains.
 */
export const sliceKeyFor = (
  dimension: Dimension,
  accountId: number,
  instrument: Instrument,
): string => keyAndLabel(dimension, accountId, instrument)[0];

const keyAndLabel = (
  dimension: Dimension,
  accountId: number,
  instrument: Instrument,
): readonly [string, string] => {
  switch (dimension) {
    case "kind":
      return [instrument.kind, KIND_LABELS[instrument.kind]];
    case "currency":
      return [instrument.currency, instrument.currency];
    case "account":
      return [String(accountId), `Tili ${accountId}`];
    case "instrument":
      return [String(instrument.id), instrument.name];
  }
};

/**
 * Where a cash balance lands in each dimension. Cash is part of the portfolio's
 * value (spec 10c/C2, decided 2026-08-29) but it is not an instrument, so it
 * cannot go through `keyAndLabel` -- it has no kind, no id, and its currency is
 * its own rather than a security's.
 */
const cashKeyAndLabel = (dimension: Dimension, balance: ValuedCash): readonly [string, string] => {
  switch (dimension) {
    case "kind":
      // A fixed-term deposit is its own slice rather than more "cash": it
      // behaves like a short bond, and folding the two together reports a
      // portfolio as more liquid than it is.
      return balance.locked === true
        ? ["fixed_term", "Määräaikaistalletukset"]
        : ["cash", KIND_LABELS.cash];
    case "currency":
      return [balance.currency, balance.currency];
    case "account":
      return [String(balance.accountId), `Tili ${balance.accountId}`];
    case "instrument":
      // Cash is one line rather than one per account: an instrument breakdown
      // that listed "Käteinen" three times would read as three holdings.
      return balance.locked === true
        ? ["fixed_term", "Määräaikaistalletukset"]
        : ["cash", KIND_LABELS.cash];
  }
};

export const allocateBy = (
  txns: readonly Txn[],
  instruments: readonly Instrument[],
  prices: PriceLookup,
  on: IsoDate,
  dimension: Dimension,
  cash: readonly ValuedCash[] = [],
): AllocationResult => {
  const byId = new Map(instruments.map((i) => [i.id, i]));
  const totals = new Map<string, { label: string; value: Money }>();
  const excludedInstrumentIds = new Set<number>();

  // Account grouping needs per-account positions, so walk transactions per account.
  const accountIds = [...new Set(txns.map((t) => t.accountId))];
  const buckets: Array<{ accountId: number; positions: Map<number, Quantity> }> = accountIds.map(
    (accountId) => ({
      accountId,
      positions: positionsAt(
        txns.filter((t) => t.accountId === accountId),
        on,
      ),
    }),
  );

  for (const { accountId, positions } of buckets) {
    for (const [instrumentId, qty] of positions) {
      // A negative quantity means an unmatched disposal (see ledger.ts's
      // `negativePositionIds`, which the server layer uses to tell the caller
      // which instruments this excluded) -- price * qty would be negative, and
      // silently subtracting that from a bucket's total is exactly the
      // "plausible but wrong number" this must not produce. Skip its
      // contribution entirely rather than count it as either a negative or a
      // zero amount. Reported via `negativePositionIds` instead of this
      // function's own `excludedInstrumentIds` -- see that field's doc.
      if (qty.scaled < 0n) continue;
      const instrument = byId.get(instrumentId);
      if (!instrument) continue;
      const price = prices.priceOn(instrumentId, on);
      if (price === null) {
        // C1: no price at all for `on` -- this holding cannot be valued, so it must
        // not just disappear from the response with no trace.
        excludedInstrumentIds.add(instrumentId);
        continue;
      }
      const native = mulMoney(price, qty, "half-up");
      const rate = instrument.currency === EUR ? null : prices.fxOn(instrument.currency, on);
      if (instrument.currency !== EUR && rate === null) {
        // C1: a real price exists, but this non-EUR instrument has no fx rate for
        // `on` -- excluded for the same reason as a missing price, not folded in as
        // an implied 0,00 €.
        excludedInstrumentIds.add(instrumentId);
        continue;
      }
      const valueEur = rate === null ? native : toEur(native, rate, "half-up");

      const [key, label] = keyAndLabel(dimension, accountId, instrument);

      const existing = totals.get(key);
      totals.set(key, {
        label,
        value: existing ? addMoney(existing.value, valueEur) : valueEur,
      });
    }
  }

  // Cash joins the same buckets as the positions, so weights are shares of a
  // total that includes it. A balance with no fx rate for the day carries a null
  // value and is skipped here, the same as an unpriceable holding above.
  for (const balance of cash) {
    if (balance.valueEur === null) continue;
    // A negative balance is an overdraft, not an asset: letting it subtract from
    // a bucket would make every other slice's weight a share of a total that
    // does not exist. It is still reported as a balance by /api/cash.
    if (balance.valueEur.minor <= 0n) continue;
    const [key, label] = cashKeyAndLabel(dimension, balance);
    const existing = totals.get(key);
    totals.set(key, {
      label,
      value: existing ? addMoney(existing.value, balance.valueEur) : balance.valueEur,
    });
  }

  const total = [...totals.values()].reduce((sum, t) => addMoney(sum, t.value), zeroMoney(EUR));
  if (total.minor === 0n) return { slices: [], excludedInstrumentIds: [...excludedInstrumentIds] };

  const slices = [...totals.entries()]
    .map(([key, { label, value }]) => ({
      key,
      label,
      valueEur: value,
      weight: Number(value.minor) / Number(total.minor),
    }))
    .sort((a, b) =>
      b.valueEur.minor === a.valueEur.minor
        ? a.key.localeCompare(b.key)
        : b.valueEur.minor > a.valueEur.minor
          ? 1
          : -1,
    );
  return { slices, excludedInstrumentIds: [...excludedInstrumentIds] };
};

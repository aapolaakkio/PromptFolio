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
   * Held at `on` but left out for want of a price or fx rate. Negative positions are not
   * listed: they are judged over the whole ledger, this sees one account at a time.
   */
  readonly excludedInstrumentIds: readonly number[];
};

const KIND_LABELS = {
  stock: "Shares",
  etf: "ETFs",
  fund: "Funds",
  cash: "Cash",
} satisfies Record<Instrument["kind"], string>;

/** Which slice a holding falls into; exported so callers acting on a slice derive it the same way. */
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
      return [String(accountId), `Account ${accountId}`];
    case "instrument":
      return [String(instrument.id), instrument.name];
  }
};

/** Where a cash balance lands per dimension; cash is not an instrument, so it bypasses `keyAndLabel`. */
const cashKeyAndLabel = (dimension: Dimension, balance: ValuedCash): readonly [string, string] => {
  switch (dimension) {
    // A fixed-term deposit is its own slice: folding it into cash overstates liquidity.
    // By instrument, cash is one line rather than one per account.
    case "kind":
    case "instrument":
      return balance.locked === true
        ? ["fixed_term", "Fixed-term deposits"]
        : ["cash", KIND_LABELS.cash];
    case "currency":
      return [balance.currency, balance.currency];
    case "account":
      return [String(balance.accountId), `Account ${balance.accountId}`];
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
      // Unmatched disposal: reported elsewhere, never priced.
      if (qty.scaled < 0n) continue;
      const instrument = byId.get(instrumentId);
      if (!instrument) continue;
      const price = prices.priceOn(instrumentId, on);
      if (price === null) {
        excludedInstrumentIds.add(instrumentId);
        continue;
      }
      const native = mulMoney(price, qty, "half-up");
      const rate = instrument.currency === EUR ? null : prices.fxOn(instrument.currency, on);
      if (instrument.currency !== EUR && rate === null) {
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

  // Cash joins the same buckets so weights include it; an unvalued balance is skipped.
  for (const balance of cash) {
    if (balance.valueEur === null) continue;
    // An overdraft is not an asset (still reported by /api/cash).
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

import { addMoney, EUR, mulMoney, toEur, zeroMoney, type Money, type Quantity } from "./money";
import { positionsAt } from "./ledger";
import type { PriceLookup } from "./returns";
import type { Instrument, IsoDate, Txn } from "./types";

export type Dimension = "kind" | "currency" | "account" | "instrument";

export type Slice = {
  readonly key: string;
  readonly label: string;
  readonly valueEur: Money;
  readonly weight: number;
};

const KIND_LABELS = {
  stock: "Osakkeet",
  etf: "ETF:t",
  fund: "Rahastot",
  cash: "Käteinen",
} satisfies Record<Instrument["kind"], string>;

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

export const allocateBy = (
  txns: readonly Txn[],
  instruments: readonly Instrument[],
  prices: PriceLookup,
  on: IsoDate,
  dimension: Dimension,
): Slice[] => {
  const byId = new Map(instruments.map((i) => [i.id, i]));
  const totals = new Map<string, { label: string; value: Money }>();

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
      // zero amount.
      if (qty.scaled < 0n) continue;
      const instrument = byId.get(instrumentId);
      if (!instrument) continue;
      const price = prices.priceOn(instrumentId, on);
      if (price === null) continue;
      const native = mulMoney(price, qty, "half-up");
      const rate = instrument.currency === EUR ? null : prices.fxOn(instrument.currency, on);
      if (instrument.currency !== EUR && rate === null) continue;
      const valueEur = rate === null ? native : toEur(native, rate, "half-up");

      const [key, label] = keyAndLabel(dimension, accountId, instrument);

      const existing = totals.get(key);
      totals.set(key, {
        label,
        value: existing ? addMoney(existing.value, valueEur) : valueEur,
      });
    }
  }

  const total = [...totals.values()].reduce((sum, t) => addMoney(sum, t.value), zeroMoney(EUR));
  if (total.minor === 0n) return [];

  return [...totals.entries()]
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
};

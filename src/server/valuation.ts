import { asc, eq, inArray } from "drizzle-orm";
import { costBasisAt } from "../core/costbasis";
import { positionsAt } from "../core/ledger";
import {
  EUR,
  formatMoney,
  formatQuantity,
  mulMoney,
  parseCurrency,
  subMoney,
  toEur,
  zeroMoney,
  type Currency,
  type FxRate,
  type Money,
} from "../core/money";
import type { PriceLookup } from "../core/returns";
import type { Instrument, IsoDate, Txn } from "../core/types";
import type { getDb } from "./db";
import { accounts, fxRates, instruments, prices, transactions } from "./db/schema";

type Db = ReturnType<typeof getDb>["db"];

/**
 * Reconstructs a `Money`/`FxRate` amount from a stored row's minor-unit
 * integer and currency text. `db/schema.ts`'s `.$type<Currency>()` gives a
 * row's `currency` column a free, UNVALIDATED cast to the branded
 * `Currency` type at compile time -- a value can sit in the column without
 * ever having passed `parseCurrency` (e.g. a hand-edited row, or one
 * written by a future migration this code predates). `loadPortfolio`
 * below is the one place `core` money gets rebuilt from a database row, so
 * it is also the one place that cast is not simply trusted: both helpers
 * take the raw column as a plain `string` and run it through
 * `parseCurrency` for real, so a malformed stored code fails loudly here
 * rather than silently entering a `Money`/`FxRate` that every downstream
 * `core` computation then treats as pre-validated.
 */
const asMoney = (minor: number, currency: string): Money => ({
  minor: BigInt(minor),
  currency: parseCurrency(currency),
});
const asRate = (scaled: number, currency: string): FxRate => ({
  scaled: BigInt(scaled),
  currency: parseCurrency(currency),
});

/** Last row with `date <= on`, or null. `list` must already be sorted ascending by date. */
const latestOnOrBefore = <T extends { date: string }>(
  list: readonly T[] | undefined,
  on: string,
): T | null => {
  if (!list) return null;
  let found: T | null = null;
  for (const row of list) {
    if (row.date > on) break;
    found = row;
  }
  return found;
};

const groupBy = <T, K>(rows: readonly T[], keyOf: (row: T) => K): Map<K, T[]> => {
  const groups = new Map<K, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  return groups;
};

export type Portfolio = {
  readonly txns: readonly Txn[];
  readonly instruments: readonly Instrument[];
  readonly prices: PriceLookup;
};

/**
 * Loads every transaction the given user owns (via their accounts), every
 * instrument (shared reference data, not user-scoped -- mirrors
 * `instruments.ts`'s `/api/instruments` GET), and a `PriceLookup` closed
 * over that user's prices and FX rates. `core` never sees a database row;
 * this is the one module that translates between storage integers and
 * `core`'s `Money`/`Quantity`/`FxRate`.
 */
export const loadPortfolio = (db: Db, userId: string): Portfolio => {
  const ownedAccountIds = db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.userId, userId))
    .all()
    .map((row) => row.id);

  const txnRows =
    ownedAccountIds.length === 0
      ? []
      : db
          .select()
          .from(transactions)
          .where(inArray(transactions.accountId, ownedAccountIds))
          .orderBy(asc(transactions.tradeDate), asc(transactions.id))
          .all();

  const txns: Txn[] = txnRows.map((row) => ({
    id: row.id,
    accountId: row.accountId,
    instrumentId: row.instrumentId,
    type: row.type,
    tradeDate: row.tradeDate,
    quantity: { scaled: BigInt(row.quantity) },
    unitPrice: row.unitPrice === null ? null : asMoney(row.unitPrice, row.currency),
    amount: asMoney(row.amount, row.currency),
    fee: asMoney(row.fee, row.currency),
    tax: asMoney(row.tax, row.currency),
    currency: parseCurrency(row.currency),
    fxRateEur: asRate(row.fxRateEur, row.currency),
  }));

  const instrumentList: Instrument[] = db
    .select()
    .from(instruments)
    .all()
    .map((row) => ({
      id: row.id,
      isin: row.isin,
      ticker: row.ticker,
      name: row.name,
      kind: row.kind,
      currency: parseCurrency(row.currency),
      priceSource: row.priceSource,
      sourceKey: row.sourceKey,
    }));

  const priceRows = db.select().from(prices).orderBy(asc(prices.date)).all();
  const pricesByInstrument = groupBy(priceRows, (row) => row.instrumentId);

  const fxRows = db.select().from(fxRates).orderBy(asc(fxRates.date)).all();
  const fxByCurrency = groupBy(fxRows, (row) => row.currency);

  const priceLookup: PriceLookup = {
    priceOn: (instrumentId, date) => {
      const row = latestOnOrBefore(pricesByInstrument.get(instrumentId), date);
      return row ? asMoney(row.close, row.currency) : null;
    },
    priceDateOn: (instrumentId, date) =>
      latestOnOrBefore(pricesByInstrument.get(instrumentId), date)?.date ?? null,
    fxOn: (currency, date) => {
      if (currency === EUR) return asRate(100_000_000, EUR);
      const row = latestOnOrBefore(fxByCurrency.get(currency), date);
      return row ? asRate(row.rateEur, row.currency) : null;
    },
  };

  return { txns, instruments: instrumentList, prices: priceLookup };
};

export type HoldingView = {
  readonly instrumentId: number;
  readonly isin: string;
  readonly name: string;
  readonly kind: Instrument["kind"];
  readonly currency: Currency;
  readonly quantity: string;
  readonly costEur: string;
  readonly valueEur: string;
  readonly unrealisedEur: string;
  readonly priceDate: IsoDate | null;
  readonly stale: boolean;
};

/**
 * Current holdings, valued as of `on`. `stale` is `true` whenever the price
 * actually used was not dated `on` itself (carried forward from an earlier
 * date, per `PriceLookup.priceDateOn`'s contract) or was missing entirely --
 * either way the UI must show the staleness badge rather than a number that
 * looks as current as it is not.
 */
export const holdingsFor = (db: Db, userId: string, on: IsoDate): HoldingView[] => {
  const { txns, instruments: all, prices: lookup } = loadPortfolio(db, userId);
  const byId = new Map(all.map((instrument) => [instrument.id, instrument]));
  const costs = costBasisAt(txns, on);

  return [...positionsAt(txns, on)]
    .flatMap(([instrumentId, quantity]) => {
      const instrument = byId.get(instrumentId);
      if (!instrument) return [];

      const price = lookup.priceOn(instrumentId, on);
      const priceDate = lookup.priceDateOn(instrumentId, on);
      const rate = instrument.currency === EUR ? null : lookup.fxOn(instrument.currency, on);

      const valueEur =
        price === null || (instrument.currency !== EUR && rate === null)
          ? zeroMoney(EUR)
          : rate === null
            ? mulMoney(price, quantity)
            : toEur(mulMoney(price, quantity), rate);
      const costEur = costs.get(instrumentId) ?? zeroMoney(EUR);

      const holding: HoldingView = {
        instrumentId,
        isin: instrument.isin,
        name: instrument.name,
        kind: instrument.kind,
        currency: instrument.currency,
        quantity: formatQuantity(quantity),
        costEur: formatMoney(costEur),
        valueEur: formatMoney(valueEur),
        unrealisedEur: formatMoney(subMoney(valueEur, costEur)),
        priceDate,
        stale: priceDate !== on,
      };
      return [holding];
    })
    .sort((a, b) => Number(b.valueEur) - Number(a.valueEur));
};

import { asc, eq, inArray } from "drizzle-orm";
import { costBasisPerInstrument, type CostBasisOutcome } from "../core/costbasis.ts";
import {
  availableCashEur,
  cashBalancesAt,
  lockedCashEur,
  totalCashEur,
  valueCash,
  type ValuedCash,
} from "../core/cash.ts";
import { yearlyCostEur } from "../core/fund-costs.ts";
import { positionsAt } from "../core/ledger.ts";
import {
  addMoney,
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
} from "../core/money.ts";
import type { PriceLookup } from "../core/returns.ts";
import { isPriceStale } from "../core/staleness.ts";
import type { Instrument, IsoDate, Txn } from "../core/types.ts";
import type { Db } from "./db/index.ts";
import { isPublicPageUrl } from "./prices/page.ts";
import {
  accounts,
  fxRates,
  instrumentCosts,
  instruments,
  prices,
  transactions,
} from "./db/schema.ts";

/** The one place money leaves the database: the stored currency is an unvalidated cast, so check it here. */
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
  /** `txns` minus bank accounts: a grocery payment must not read as capital withdrawn. Money reaching a broker still counts via the broker's export. */
  readonly investedTxns: readonly Txn[];
  readonly instruments: readonly Instrument[];
  readonly prices: PriceLookup;
  readonly bankAccountIds: readonly number[];
  /** `txns` minus credit accounts: a card holds no money, so its balance would subtract the same spend twice. */
  readonly cashTxns: readonly Txn[];
  /** First price strictly after `date`, or null. Tells a market holiday from a real gap without an exchange calendar. */
  readonly nextPriceDateAfter: (instrumentId: number, date: IsoDate) => IsoDate | null;
};

/**
 * Prices the owner actually traded at, as price points: the only real history for a fund or share
 * whose source has none, and better than valuing at cost. A stored price for the day wins.
 * Skipped before a split of the same instrument (pre-split units).
 */
// ponytail: pre-split trades dropped rather than adjusted by the split ratio;
// adjust them if a split instrument's early history matters.
export const tradedPrices = (
  txns: readonly Txn[],
  stored: readonly { instrumentId: number; date: string }[],
) => {
  const storedDays = new Set(stored.map((row) => `${row.instrumentId}|${row.date}`));
  const lastSplit = new Map<number, string>();
  for (const txn of txns) {
    if (txn.type !== "SPLIT" || txn.instrumentId === null) continue;
    const seen = lastSplit.get(txn.instrumentId);
    if (seen === undefined || txn.tradeDate > seen) lastSplit.set(txn.instrumentId, txn.tradeDate);
  }
  return txns.flatMap((txn) => {
    if (txn.type !== "BUY" && txn.type !== "SELL") return [];
    if (txn.instrumentId === null || txn.unitPrice === null || txn.unitPrice.minor <= 0n) return [];
    if (storedDays.has(`${txn.instrumentId}|${txn.tradeDate}`)) return [];
    const split = lastSplit.get(txn.instrumentId);
    if (split !== undefined && txn.tradeDate < split) return [];
    storedDays.add(`${txn.instrumentId}|${txn.tradeDate}`);
    return [
      {
        instrumentId: txn.instrumentId,
        date: txn.tradeDate,
        close: Number(txn.unitPrice.minor),
        currency: txn.unitPrice.currency,
      },
    ];
  });
};

export const loadPortfolio = async (db: Db, userId: string): Promise<Portfolio> => {
  const ownedAccountIds = (
    await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.userId, userId)).all()
  ).map((row) => row.id);

  const txnRows =
    ownedAccountIds.length === 0
      ? []
      : await db
          .select()
          .from(transactions)
          .where(inArray(transactions.accountId, ownedAccountIds))
          .orderBy(asc(transactions.tradeDate), asc(transactions.id))
          .all();

  // Loaded first: a row's `unit_price` is in the instrument's currency, not the row's.
  const instrumentCurrencies = new Map(
    (
      await db
        .select({ id: instruments.id, currency: instruments.currency })
        .from(instruments)
        .all()
    ).map((row) => [row.id, parseCurrency(row.currency)]),
  );

  const txns: Txn[] = txnRows.map((row) => ({
    id: row.id,
    accountId: row.accountId,
    instrumentId: row.instrumentId,
    type: row.type,
    tradeDate: row.tradeDate,
    quantity: { scaled: BigInt(row.quantity) },
    // `transactions.currency` is the cash side; the unit price is in the security's own currency (a Nordnet row proves they differ).
    unitPrice:
      row.unitPrice === null
        ? null
        : asMoney(
            row.unitPrice,
            (row.instrumentId === null ? undefined : instrumentCurrencies.get(row.instrumentId)) ??
              row.currency,
          ),
    amount: asMoney(row.amount, row.currency),
    fee: asMoney(row.fee, row.currency),
    tax: asMoney(row.tax, row.currency),
    currency: parseCurrency(row.currency),
    fxRateEur: asRate(row.fxRateEur, row.currency),
    note: row.note,
  }));

  const instrumentList: Instrument[] = (await db.select().from(instruments).all()).map((row) => ({
    id: row.id,
    isin: row.isin,
    ticker: row.ticker,
    name: row.name,
    kind: row.kind,
    currency: parseCurrency(row.currency),
    priceSource: row.priceSource,
    sourceKey: row.sourceKey,
  }));

  const storedPrices = await db.select().from(prices).orderBy(asc(prices.date)).all();
  const priceRows = [...storedPrices, ...tradedPrices(txns, storedPrices)].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
  );
  const pricesByInstrument = groupBy(priceRows, (row) => row.instrumentId);

  const fxRows = await db.select().from(fxRates).orderBy(asc(fxRates.date)).all();
  const fxByCurrency = groupBy(fxRows, (row) => row.currency);

  const nextPriceDateAfter = (instrumentId: number, date: IsoDate): IsoDate | null =>
    // groupBy preserves date order, so the first row past `date` is the nearest.
    pricesByInstrument.get(instrumentId)?.find((row) => row.date > date)?.date ?? null;

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
      if (!row) return null;
      // A 2010 rate must not value a 2026 holding: past the bound it is reported unvaluable.
      return daysBetween(row.date, date) > MAX_FX_AGE_DAYS
        ? null
        : asRate(row.rateEur, row.currency);
    },
  };

  const creditAccountIds = new Set(
    (
      await db
        .select({ id: accounts.id, accountType: accounts.accountType })
        .from(accounts)
        .where(eq(accounts.userId, userId))
        .all()
    )
      .filter((row) => row.accountType === "credit")
      .map((row) => row.id),
  );

  const bankAccountIds = (
    await db
      .select({ id: accounts.id, kind: accounts.kind })
      .from(accounts)
      .where(eq(accounts.userId, userId))
      .all()
  )
    .filter((row) => row.kind === "bank")
    .map((row) => row.id);
  const isBank = new Set(bankAccountIds);

  return {
    txns,
    investedTxns: txns.filter((txn) => !isBank.has(txn.accountId)),
    instruments: instrumentList,
    prices: priceLookup,
    bankAccountIds,
    cashTxns: txns.filter((txn) => !creditAccountIds.has(txn.accountId)),
    nextPriceDateAfter,
  };
};

/** Max rate age before a valuation refuses it: covers a holiday weekend plus a missed refresh. */
const MAX_FX_AGE_DAYS = 10;

/** Whole days from `from` to `to`, both ISO dates. Negative when `to` precedes `from`. */
const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

type HoldingView = {
  readonly instrumentId: number;
  readonly isin: string | null;
  readonly name: string;
  readonly kind: Instrument["kind"];
  readonly currency: Currency;
  readonly priceSource: Instrument["priceSource"];
  readonly sourceKey: string;
  readonly lookupStatus: "ok" | "pending" | "attention";
  readonly quantity: string;
  /** Null exactly when `costBasisError` is set (an unmatched disposal): quantity can be negative, so a value from it would be nonsense. */
  readonly costEur: string | null;
  /** Null with `unrealisedEur` exactly when `valuationError` is set (no price or no fx rate for `on`), never a fabricated 0. */
  readonly valueEur: string | null;
  readonly unrealisedEur: string | null;
  /** Share of the valued portfolio, as a number. Null (never 0) when unvaluable; the denominator counts valued holdings only. */
  readonly weight: number | null;
  readonly priceDate: IsoDate | null;
  /** Ongoing yearly charge in basis points (20 is 0.20 %); null while unknown. */
  readonly ongoingChargeBp: number | null;
  /** `valueEur` x charge per year; null when either is unknown. */
  readonly yearlyCostEur: string | null;
  /** Where the charge came from; `url` only when it is a public https page. Null while no charge is known. */
  readonly chargeSource: {
    readonly url: string | null;
    readonly source: "ai" | "user";
  } | null;
  /** Needs a staleness badge: price older than it could be, missing, or unvaluable for any other reason. */
  readonly stale: boolean;
  readonly costBasisError: { readonly tradeDate: IsoDate; readonly message: string } | null;
  /** See `valueEur`. User-facing; names the instrument and the date. */
  readonly valuationError: string | null;
};

const explainUnmatchedDisposal = (instrument: Instrument, tradeDate: IsoDate): string =>
  `The sale of ${instrument.name} (${instrument.isin}) on ${tradeDate} cannot be processed, ` +
  `because no purchase was recorded for the instrument before this sale: import the missing ` +
  `purchases or delete the sale row.`;

const explainValuationFailure = (
  instrument: Instrument,
  on: IsoDate,
  reason: "no-price" | "no-fx-rate",
): string =>
  reason === "no-price"
    ? `${instrument.name} (${instrument.isin}) has no price on ${on}, ` +
      `so its market value cannot be computed.`
    : `No exchange rate for ${instrument.currency} on ${on}, so the market value of ` +
      `${instrument.name} (${instrument.isin}) cannot be computed.`;

const chargeSourceOf = (
  row: typeof instrumentCosts.$inferSelect | undefined,
): HoldingView["chargeSource"] =>
  row === undefined || row.ongoingChargeBp === null
    ? null
    : {
        url: row.sourceUrl !== null && isPublicPageUrl(row.sourceUrl) ? row.sourceUrl : null,
        source: row.source,
      };

const yearlyCostFor = (valueEur: Money | null, bp: number | null): string | null =>
  valueEur === null || bp === null ? null : formatMoney(yearlyCostEur(valueEur, bp));

/** Holdings valued as of `on`. Cost basis is per instrument: an unmatched disposal marks only its own row (pages import newest first). */
export const holdingsFor = async (db: Db, userId: string, on: IsoDate): Promise<HoldingView[]> => {
  const { txns, instruments: all, prices: lookup } = await loadPortfolio(db, userId);
  const byId = new Map(all.map((instrument) => [instrument.id, instrument]));
  const statusById = new Map(
    (
      await db
        .select({ id: instruments.id, lookupStatus: instruments.lookupStatus })
        .from(instruments)
        .all()
    ).map((row) => [row.id, row.lookupStatus]),
  );
  const chargeRows = new Map(
    (await db.select().from(instrumentCosts).all()).map((row) => [row.instrumentId, row]),
  );
  const costs = costBasisPerInstrument(txns, on);

  const rows = [...positionsAt(txns, on)].flatMap((entry) => {
    const [instrumentId, quantity] = entry;
    const instrument = byId.get(instrumentId);
    if (!instrument) return [];

    const price = lookup.priceOn(instrumentId, on);
    const priceDate = lookup.priceDateOn(instrumentId, on);
    const rate = instrument.currency === EUR ? null : lookup.fxOn(instrument.currency, on);

    const nativeValueEur: Money | null =
      price === null
        ? null
        : instrument.currency !== EUR && rate === null
          ? null
          : rate === null
            ? mulMoney(price, quantity)
            : toEur(mulMoney(price, quantity), rate);
    const valuationError =
      price === null
        ? explainValuationFailure(instrument, on, "no-price")
        : instrument.currency !== EUR && rate === null
          ? explainValuationFailure(instrument, on, "no-fx-rate")
          : null;

    const outcome: CostBasisOutcome | undefined = costs.get(instrumentId);
    const costBasisError =
      outcome && !outcome.ok
        ? {
            tradeDate: outcome.error.tradeDate,
            message: explainUnmatchedDisposal(instrument, outcome.error.tradeDate),
          }
        : null;
    const costEur = costBasisError ? null : outcome?.ok ? outcome.costEur : zeroMoney(EUR);

    // valueEur, unrealisedEur and weight all key off one "can this be trusted" check.
    const valuedEur: Money | null = costBasisError === null ? nativeValueEur : null;

    return [
      {
        instrumentId,
        instrument,
        quantity,
        valuedEur,
        priceDate,
        valuationError,
        costBasisError,
        costEur,
      },
    ];
  });

  const totalValuedEur = rows.reduce(
    (sum, row) => (row.valuedEur === null ? sum : addMoney(sum, row.valuedEur)),
    zeroMoney(EUR),
  );

  return rows
    .map((row): HoldingView => ({
      instrumentId: row.instrumentId,
      isin: row.instrument.isin,
      name: row.instrument.name,
      kind: row.instrument.kind,
      currency: row.instrument.currency,
      priceSource: row.instrument.priceSource,
      sourceKey: row.instrument.sourceKey,
      lookupStatus: statusById.get(row.instrumentId) ?? "ok",
      quantity: formatQuantity(row.quantity),
      costEur: row.costEur === null ? null : formatMoney(row.costEur),
      valueEur: row.valuedEur === null ? null : formatMoney(row.valuedEur),
      unrealisedEur:
        row.costEur === null || row.valuedEur === null
          ? null
          : formatMoney(subMoney(row.valuedEur, row.costEur)),
      weight:
        row.valuedEur === null || totalValuedEur.minor === 0n
          ? null
          : Number(row.valuedEur.minor) / Number(totalValuedEur.minor),
      ongoingChargeBp: chargeRows.get(row.instrumentId)?.ongoingChargeBp ?? null,
      yearlyCostEur: yearlyCostFor(
        row.valuedEur,
        chargeRows.get(row.instrumentId)?.ongoingChargeBp ?? null,
      ),
      chargeSource: chargeSourceOf(chargeRows.get(row.instrumentId)),
      priceDate: row.priceDate,
      stale:
        row.valuationError !== null ||
        isPriceStale({ kind: row.instrument.kind, priceDate: row.priceDate, on }),
      costBasisError: row.costBasisError,
      valuationError: row.valuationError,
    }))
    .sort((a, b) => Number(b.valueEur ?? "0") - Number(a.valueEur ?? "0"));
};

/** Cash per account plus totals: everything, spendable today, and locked in a fixed-term deposit until maturity. */
type CashReport = {
  readonly rows: CashView[];
  readonly totalEur: string;
  readonly availableEur: string;
  readonly lockedEur: string;
};

type CashView = {
  readonly accountId: number;
  readonly accountName: string;
  readonly currency: Currency;
  readonly amount: string;
  /** Null when no fx rate is known for `on`. */
  readonly valueEur: string | null;
  readonly locked: boolean;
  readonly availableFrom: string | null;
};

/** Marks each balance by whether its account can be drawn on `on`. A deposit with no entered terms counts as locked. */
export const withAvailability = async (
  db: Db,
  userId: string,
  balances: readonly ValuedCash[],
  on: IsoDate,
): Promise<ValuedCash[]> => {
  const terms = new Map(
    (
      await db
        .select({
          id: accounts.id,
          accountType: accounts.accountType,
          maturityDate: accounts.maturityDate,
        })
        .from(accounts)
        .where(eq(accounts.userId, userId))
        .all()
    ).map((row) => [row.id, row]),
  );

  return balances.map((balance) => {
    const account = terms.get(balance.accountId);
    if (account?.accountType !== "fixed_term") return { ...balance, locked: false };
    const maturity = account.maturityDate;
    return {
      ...balance,
      locked: maturity === null || maturity > on,
      availableFrom: maturity,
    };
  });
};

export const cashFor = async (db: Db, userId: string, on: IsoDate): Promise<CashReport> => {
  const { cashTxns, prices } = await loadPortfolio(db, userId);
  const names = new Map(
    (
      await db
        .select({ id: accounts.id, name: accounts.name })
        .from(accounts)
        .where(eq(accounts.userId, userId))
        .all()
    ).map((row) => [row.id, row.name]),
  );

  const valued = await withAvailability(
    db,
    userId,
    valueCash(cashBalancesAt(cashTxns, on), prices.fxOn, on),
    on,
  );
  return {
    rows: valued.map((balance) => ({
      accountId: balance.accountId,
      accountName: names.get(balance.accountId) ?? `Account ${balance.accountId}`,
      currency: balance.currency,
      amount: formatMoney(balance.amount),
      valueEur: balance.valueEur === null ? null : formatMoney(balance.valueEur),
      locked: balance.locked === true,
      availableFrom: balance.availableFrom ?? null,
    })),
    totalEur: formatMoney(totalCashEur(valued)),
    availableEur: formatMoney(availableCashEur(valued)),
    lockedEur: formatMoney(lockedCashEur(valued)),
  };
};

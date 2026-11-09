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
import { accounts, fxRates, instruments, prices, transactions } from "./db/schema.ts";

/**
 * Rebuilds core money from a stored row. The schema's currency type is a free,
 * unvalidated cast, and this is the one place money comes out of the database,
 * so it is the one place that cast is checked rather than trusted onward.
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
  /** Every transaction the user owns, bank accounts included. Cash reads this. */
  readonly txns: readonly Txn[];
  /**
   * The same, minus every bank account -- what the return figures are computed
   * from. A bank row is spending or salary, not a portfolio event, and a grocery
   * payment left in would read as capital pulled out. Money that really reaches a
   * broker still counts: the broker's own export records its arrival.
   */
  readonly investedTxns: readonly Txn[];
  readonly instruments: readonly Instrument[];
  readonly prices: PriceLookup;
  /** Account ids whose kind is a bank one, for callers that group by account. */
  readonly bankAccountIds: readonly number[];
  /**
   * The same, minus every credit account. A card holds no money, so counting its
   * balance as cash subtracts the same money twice -- as the purchases and as
   * the debt they created. Spending still reads `txns`, which is what it is about.
   */
  readonly cashTxns: readonly Txn[];
  /**
   * The first price strictly after `date`, or null. Tells a market holiday from a
   * real gap without an exchange calendar: a bar a day later and none on the date
   * means the market was shut, and no Finnish holiday table covers a German one.
   */
  readonly nextPriceDateAfter: (instrumentId: number, date: IsoDate) => IsoDate | null;
};

/**
 * Every transaction the user owns, every instrument, and a price lookup.
 *
 * `core` never sees a database row: this is the one module that translates
 * between storage integers and `Money`/`Quantity`/`FxRate`.
 */
/**
 * The price the owner actually traded at, as a price point: a buy or a sale's
 * unit price is what the instrument was worth that day. For a fund whose source
 * serves only its latest value, or a share whose source refuses us, these are
 * the only real historical prices there are, and they beat valuing a holding
 * at cost. A stored price for the same day wins.
 *
 * Skipped before a split of the same instrument: those prices are in pre-split
 * units, while the valuation restates held quantities into post-split ones.
 */
// ponytail: pre-split trades dropped rather than adjusted by the split ratio;
// adjust them if a split instrument's early history matters.
const tradedPrices = (
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

  // Loaded before the transactions because a row's `unit_price` is denominated
  // in its instrument's currency, not in the row's own (see below).
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
    // `transactions.currency` is the cash side -- what the account was debited
    // in -- while the unit price is in the security's own currency. A real
    // Nordnet row proves they differ, and tagging the price with the cash
    // currency states a SEK figure as euros.
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
    // Ordered by date, and groupBy preserves it, so the first row past `date`
    // is the nearest one.
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
      // Carrying a rate forward is right across a weekend and wrong across
      // years: a 2010 rate converted a 2026 holding into a sound-looking wrong
      // number. Past the bound the holding is reported unvaluable instead.
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

/**
 * How stale a rate may be before a valuation refuses it. A holiday weekend
 * reaches four days; ten leaves room for that and a missed refresh while still
 * catching what this exists for -- a rate years out of date, carried forward.
 */
const MAX_FX_AGE_DAYS = 10;

/** Whole days from `from` to `to`, both ISO dates. Negative when `to` precedes `from`. */
const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

export type HoldingView = {
  readonly instrumentId: number;
  /** Null for a holding no registry carries -- see instruments.isin. */
  readonly isin: string | null;
  readonly name: string;
  readonly kind: Instrument["kind"];
  readonly currency: Currency;
  readonly priceSource: Instrument["priceSource"];
  readonly sourceKey: string;
  /** "pending" while a registry lookup is owed, "attention" when it needs the owner. */
  readonly lookupStatus: "ok" | "pending" | "attention";
  readonly quantity: string;
  /**
   * Null exactly when `costBasisError` is set: a disposal with no matching
   * earlier purchase makes the cost genuinely unknown, and `quantity` can then
   * be negative, so a market value derived from it would be nonsense. The row
   * still comes back with the quantity as-is and the error explaining the gap,
   * rather than one bad position taking the whole response down.
   */
  readonly costEur: string | null;
  /**
   * Null together with `unrealisedEur`, exactly when `valuationError` is set: no
   * price for `on`, or no fx rate for it. This used to fall back to a fabricated
   * 0,00 EUR with no staleness badge -- a real price dated `on` and a missing
   * rate rendered a confident, wrong loss.
   */
  readonly valueEur: string | null;
  readonly unrealisedEur: string | null;
  /**
   * Share of the portfolio. A ratio, so a number on the wire, computed here
   * rather than from strings in the UI. Null and never 0 when the holding cannot
   * be valued -- a different claim. The denominator counts only valued holdings,
   * so weights sum to 1 across those instead of all shrinking when a feed breaks.
   */
  readonly weight: number | null;
  readonly priceDate: IsoDate | null;
  /**
   * Whether the figure needs a staleness badge: the price is older than this
   * instrument could freshly be, missing, or the holding is unvaluable for some
   * other reason. The date comparison alone is not enough -- a same-day price
   * row can still leave a holding unvaluable.
   */
  readonly stale: boolean;
  readonly costBasisError: { readonly tradeDate: IsoDate; readonly message: string } | null;
  /** See `valueEur`'s doc. Finnish, user-facing, names the instrument and the date. */
  readonly valuationError: string | null;
};

/** Names the instrument by ISIN and name, never the internal id, and the date. */
const explainUnmatchedDisposal = (instrument: Instrument, tradeDate: IsoDate): string =>
  `Myyntiä ${instrument.name} (${instrument.isin}) päivältä ${tradeDate} ei voi käsitellä, ` +
  `koska instrumentille ei ole kirjattu ostotapahtumaa ennen tätä myyntiä: tuo puuttuvat ` +
  `ostotapahtumat tai poista myyntirivi.`;

/** Why a holding could not be valued: no price for `on`, or no fx rate for it. */
const explainValuationFailure = (
  instrument: Instrument,
  on: IsoDate,
  reason: "no-price" | "no-fx-rate",
): string =>
  reason === "no-price"
    ? `Instrumentille ${instrument.name} (${instrument.isin}) ei ole hintaa päivälle ${on}, ` +
      `joten markkina-arvoa ei voi laskea.`
    : `Valuuttakurssia ${instrument.currency} ei löydy päivälle ${on}, joten instrumentin ` +
      `${instrument.name} (${instrument.isin}) markkina-arvoa ei voi laskea.`;

/**
 * Current holdings, valued as of `on`. Cost basis is resolved per instrument, so
 * one unmatched disposal marks only its own row unknown. Refusing the sale at
 * import time would be wrong: pages arrive newest first.
 */
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
  const costs = costBasisPerInstrument(txns, on);

  // Everything but `weight`, which needs the total across every other row.
  const rows = [...positionsAt(txns, on)].flatMap((entry) => {
    const [instrumentId, quantity] = entry;
    const instrument = byId.get(instrumentId);
    if (!instrument) return [];

    const price = lookup.priceOn(instrumentId, on);
    const priceDate = lookup.priceDateOn(instrumentId, on);
    const rate = instrument.currency === EUR ? null : lookup.fxOn(instrument.currency, on);

    // No zero fallback: a holding this cannot price reports null and says why.
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
    // Both walk the same transactions, so an absent outcome is defensive only.
    const costEur = costBasisError ? null : outcome?.ok ? outcome.costEur : zeroMoney(EUR);

    // One source of truth for "can this value be trusted": valueEur,
    // unrealisedEur and weight all key off it, so the three stay in lockstep
    // rather than three separate conditions drifting apart.
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

  // The denominator: every holding that could be valued -- see weight's own doc.
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
      // Guards 0/0: an undefined ratio must not surface as NaN or a fake 0.
      weight:
        row.valuedEur === null || totalValuedEur.minor === 0n
          ? null
          : Number(row.valuedEur.minor) / Number(totalValuedEur.minor),
      priceDate: row.priceDate,
      stale:
        row.valuationError !== null ||
        isPriceStale({ kind: row.instrument.kind, priceDate: row.priceDate, on }),
      costBasisError: row.costBasisError,
      valuationError: row.valuationError,
    }))
    .sort((a, b) => Number(b.valueEur ?? "0") - Number(a.valueEur ?? "0"));
};

/**
 * One account's cash, and the household totals, as the API reports them.
 *
 * Three figures rather than one: everything, what can be spent today, and what
 * is tied up in a fixed-term deposit until it matures. A single total would
 * claim a deposit locked until 2027 is money available now.
 */
export type CashReport = {
  readonly rows: CashView[];
  readonly totalEur: string;
  readonly availableEur: string;
  readonly lockedEur: string;
};

/** One account's cash, as the API and the chat tools report it. */
type CashView = {
  readonly accountId: number;
  readonly accountName: string;
  readonly currency: Currency;
  readonly amount: string;
  /** Null when no fx rate is known for `on` -- the balance is real, its euro value is not. */
  readonly valueEur: string | null;
  /** True while a fixed-term deposit has not yet matured. */
  readonly locked: boolean;
  /** The day a locked balance comes free, or null when the account records none. */
  readonly availableFrom: string | null;
};

/**
 * Uninvested cash per account and currency, in euros. It counts toward portfolio
 * value and allocation, never toward the returns: an account sitting on an
 * unspent deposit has not underperformed.
 */
/**
 * Marks each balance by whether its account can be drawn on `on`. A deposit whose
 * terms nobody entered is locked with an unknown release date, which is the
 * honest reading and safer than treating it as spendable.
 */
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
      accountName: names.get(balance.accountId) ?? `Tili ${balance.accountId}`,
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

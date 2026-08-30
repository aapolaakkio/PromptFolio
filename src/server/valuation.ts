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
import type { getDb } from "./db/index.ts";
import { accounts, fxRates, instruments, prices, transactions } from "./db/schema.ts";

type Db = ReturnType<typeof getDb>["db"];

/**
 * Rebuilds core money from a stored row.
 *
 * The schema's `.$type<Currency>()` is a free, unvalidated cast: a code can sit
 * in the column having never passed `parseCurrency`. This is the one place core
 * money comes out of the database, so it is the one place that cast is checked
 * for real rather than trusted onward.
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
   * The same, minus every bank account (current, savings, fixed-term deposit).
   *
   * This is what the return figures must be computed from. A bank account's
   * rows are spending and salary, not portfolio events: `DEPOSIT` and
   * `WITHDRAWAL` feed XIRR as external cash flows, so a grocery payment left in
   * this list would read as capital pulled out of the portfolio. Money actually
   * moving from a bank account to a broker still counts, because the broker's
   * own export records that arrival as a deposit of its own.
   */
  readonly investedTxns: readonly Txn[];
  readonly instruments: readonly Instrument[];
  readonly prices: PriceLookup;
  /** Account ids whose kind is a bank one, for callers that group by account. */
  readonly bankAccountIds: readonly number[];
  /**
   * The same transactions, minus every credit account.
   *
   * A credit card holds no money: its purchases are spending and its balance is
   * what is owed for them, so counting that balance as cash subtracts the same
   * money twice -- once as the purchases, once as the debt they created. Cash
   * figures read this; spending still reads `txns`, because the purchases are
   * exactly what a spending report is about.
   */
  readonly cashTxns: readonly Txn[];
  /**
   * The first price this instrument has strictly after `date`, or null if it
   * has none.
   *
   * Lets a caller tell a market holiday from a real gap without an exchange
   * calendar: if a price feed carries a bar a day or two after a date but none
   * on it, the market was shut. A Xetra listing on Whit Monday looked like a
   * missing price until this existed, and no Finnish holiday table would have
   * covered a German one.
   */
  readonly nextPriceDateAfter: (instrumentId: number, date: IsoDate) => IsoDate | null;
};

/**
 * Every transaction the user owns, every instrument, and a price lookup.
 *
 * `core` never sees a database row: this is the one module that translates
 * between storage integers and `Money`/`Quantity`/`FxRate`.
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

  // Loaded before the transactions because a row's `unit_price` is denominated
  // in its instrument's currency, not in the row's own (see below).
  const instrumentCurrencies = new Map(
    db
      .select({ id: instruments.id, currency: instruments.currency })
      .from(instruments)
      .all()
      .map((row) => [row.id, parseCurrency(row.currency)]),
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
    db
      .select({ id: accounts.id, accountType: accounts.accountType })
      .from(accounts)
      .where(eq(accounts.userId, userId))
      .all()
      .filter((row) => row.accountType === "credit")
      .map((row) => row.id),
  );

  const bankAccountIds = db
    .select({ id: accounts.id, kind: accounts.kind })
    .from(accounts)
    .where(eq(accounts.userId, userId))
    .all()
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
 * How stale a foreign-exchange rate may be before a valuation refuses to use it.
 *
 * ECB publishes every TARGET business day, so a gap of a few days is ordinary --
 * a long weekend with a public holiday either side reaches four. Ten leaves room
 * for that and for a refresh job that missed a run, while still catching the
 * failure this exists for: a rate years out of date, carried forward silently.
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
   * Share of the portfolio, e.g. `0.1523`. A ratio, so a number on the wire, and
   * computed here rather than re-derived from strings in the UI.
   *
   * Null, never 0, when the holding cannot be valued: "worth nothing" is a
   * different claim from "worth unknown". The denominator counts only holdings
   * that could themselves be valued, so weights still sum to 1 across those
   * rather than every weight quietly shrinking when one price feed breaks.
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
 * Current holdings, valued as of `on`.
 *
 * Cost basis is resolved per instrument, so one unmatched disposal marks only
 * that row's money fields unknown rather than refusing the whole response.
 * Refusing the sale at import time instead would be wrong: OP pages import
 * newest first, so a page legitimately holds a sale whose purchase has not
 * landed yet, and the state is right again once every page has.
 */
export const holdingsFor = (db: Db, userId: string, on: IsoDate): HoldingView[] => {
  const { txns, instruments: all, prices: lookup } = loadPortfolio(db, userId);
  const byId = new Map(all.map((instrument) => [instrument.id, instrument]));
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
export type CashView = {
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
 * Uninvested cash per account and currency on `on`, valued in euros.
 *
 * Cash counts toward portfolio value and allocation but never toward the
 * returns in spec 7 (decided 2026-08-29, recorded in 10c/C2): TWR and XIRR keep
 * measuring invested capital, so an account sitting on an unspent deposit does
 * not read as a portfolio that underperformed. The two numbers answer two
 * different questions and each says which.
 */
/**
 * Marks each balance according to whether its account can be drawn on `on`.
 *
 * A fixed-term deposit is locked until its maturity date, and locked with an
 * unknown release date when the account records none -- "we do not know when
 * this frees up" is the honest reading of a deposit whose terms nobody entered,
 * and it is safer than treating it as spendable.
 */
export const withAvailability = (
  db: Db,
  userId: string,
  balances: readonly ValuedCash[],
  on: IsoDate,
): ValuedCash[] => {
  const terms = new Map(
    db
      .select({
        id: accounts.id,
        accountType: accounts.accountType,
        maturityDate: accounts.maturityDate,
      })
      .from(accounts)
      .where(eq(accounts.userId, userId))
      .all()
      .map((row) => [row.id, row]),
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

export const cashFor = (db: Db, userId: string, on: IsoDate): CashReport => {
  const { cashTxns, prices } = loadPortfolio(db, userId);
  const names = new Map(
    db
      .select({ id: accounts.id, name: accounts.name })
      .from(accounts)
      .where(eq(accounts.userId, userId))
      .all()
      .map((row) => [row.id, row.name]),
  );

  const valued = withAvailability(
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

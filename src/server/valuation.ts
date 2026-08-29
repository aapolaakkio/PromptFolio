import { asc, eq, inArray } from "drizzle-orm";
import { costBasisPerInstrument, type CostBasisOutcome } from "../core/costbasis";
import { cashBalancesAt, totalCashEur, valueCash } from "../core/cash";
import { positionsAt } from "../core/ledger";
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
    // `transactions.currency` is the CASH side of the row -- what the account
    // was debited in -- while the broker prints the unit price in the security's
    // own currency. A real Nordnet row proves they differ: 0,6043 units at
    // 471,67 with amount -28,00, which is 285 SEK, i.e. 28 EUR. Tagging the
    // price with the cash currency would state a SEK figure as euros.
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
      if (!row) return null;
      // A rate is carried forward from the last day ECB published one, which is
      // right across a weekend or a holiday and wrong across years. Nothing
      // used to bound that: a rate dated 2010 converted a 2026 holding without
      // a murmur, and because the arithmetic was sound the result looked like a
      // real number. Beyond the bound the holding is reported unvaluable, which
      // the caller already renders as an explained gap rather than a figure.
      return daysBetween(row.date, date) > MAX_FX_AGE_DAYS
        ? null
        : asRate(row.rateEur, row.currency);
    },
  };

  return { txns, instruments: instrumentList, prices: priceLookup };
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
   * `null` exactly when `costBasisError` is non-null: a SELL/TRANSFER_OUT with no
   * matching earlier BUY (e.g. one page of a multi-page OP import pasted out of order)
   * makes this instrument's cost basis genuinely unknown. When that happens, `valueEur`
   * and `unrealisedEur` are nulled too rather than left as a lone price-times-quantity
   * figure: `quantity` for this instrument is the ledger's raw signed total (see
   * `positionsAt`), and can itself be negative in exactly this situation -- reporting a
   * "market value" computed from a nonsensical negative holding would be the same class
   * of wrong-but-plausible number this whole type exists to avoid. The row is still
   * returned, with `quantity` shown as-is (that is the honest ledger fact) and
   * `costBasisError` explaining why the money fields are missing, instead of one bad
   * position taking down every other holding's response (see `costBasisPerInstrument`
   * in `core/costbasis.ts`). `costEur` itself does NOT depend on whether this holding
   * can be *valued* (see `valueEur`'s own doc just below) -- cost basis and market value
   * are independent failure modes, and only cost basis failing here nulls this field.
   */
  readonly costEur: string | null;
  /**
   * `valueEur` and `unrealisedEur` are `null` together, exactly when `valuationError` is
   * non-null: no price is known for `on`, or (for a non-EUR instrument) no fx rate is
   * known for `on`. C1: this used to fall back to a fabricated `0,00 €` market value --
   * with `stale` computed only from `priceDate !== on`, which can itself be `false` when
   * a real price row exists dated exactly `on` and only the *fx rate* is missing (the
   * real, reproduced case: a EUR-booked, SEK-quoted fund whose SEK rate was never
   * fetched -- see `fx.ts`). That combination rendered a clean-looking, confidently
   * wrong `0,00 €` loss with no badge at all. Follows the same null-plus-explanation
   * pattern as `costBasisError` below rather than inventing a fourth shape (see
   * `core/allocation.ts`'s and `core/returns.ts`'s `excludedInstrumentIds`, the other two
   * places this same "cannot value" condition is now surfaced).
   */
  readonly valueEur: string | null;
  readonly unrealisedEur: string | null;
  /**
   * This holding's market value as a fraction of the portfolio, e.g. `0.1523` for
   * 15.23%. A ratio, not an amount -- like `core/allocation.ts`'s `Slice.weight` and
   * `/api/returns`'s `twr`/`mwr`, this is legitimately a `number` on the wire, never a
   * decimal string, and it is computed here, server-side, exactly once -- never
   * re-derived in the frontend from `valueEur` strings (spec §9.2: no money arithmetic
   * in the UI).
   *
   * `null` exactly when `valueEur` is `null`: a holding that cannot be valued (no
   * price, no fx rate, or an unmatched-disposal cost basis -- see `valueEur`'s own doc)
   * has no meaningful share of the portfolio either. `null`, not `0` -- `0` would read
   * as "this position is worth nothing", which is a different, false claim from "this
   * position's worth is unknown" (the same reasoning `valueEur`/`unrealisedEur`
   * themselves already follow).
   *
   * The denominator is the sum of every OTHER holding's `valueEur` in this same
   * response -- i.e. only holdings that could themselves be valued. This is a
   * deliberate choice, not the only defensible one: summing against the full ledger
   * (treating an unvaluable holding as contributing 0 to the total) would silently
   * shrink every other holding's weight whenever one holding's price feed breaks, with
   * no visible signal that the total is incomplete. Excluding it from the denominator
   * instead keeps "weights sum to 1 across valued holdings" true and legible, and the
   * omission is NOT silent: the excluded holding still appears in this same response
   * with `valuationError`/`costBasisError` explaining why, exactly the precedent
   * `core/allocation.ts`'s `allocateBy` already set for slice totals (its own
   * `excludedInstrumentIds`, merged into `/api/allocation`'s response). A caller wanting
   * "share of everything, valued or not" can always recompute it from `excludedInstrumentIds`
   * (returned by `/api/allocation`) plus this array -- but that is not the default a
   * plain holdings table should silently assume.
   */
  readonly weight: number | null;
  readonly priceDate: IsoDate | null;
  /**
   * `true` whenever the number shown must carry a staleness badge rather than read as
   * current: the price actually used was not dated `on` itself (carried forward from an
   * earlier date), was missing entirely, or (C1) `valuationError` is set for any other
   * reason (e.g. price present but fx rate missing) -- `priceDate !== on` alone is not a
   * sufficient check, since a same-day price row can still leave the holding unvaluable.
   */
  readonly stale: boolean;
  readonly costBasisError: { readonly tradeDate: IsoDate; readonly message: string } | null;
  /** See `valueEur`'s doc. Finnish, user-facing, names the instrument and the date. */
  readonly valuationError: string | null;
};

/**
 * The same Finnish wording this project has shown for this condition since it was
 * first caught (originally as a whole-request 400 -- see git history on this file):
 * names the instrument by its user-facing ISIN/name (never the internal numeric
 * `instrumentId`), names the trade date, and tells the user what to do about it.
 * Reuses `UnmatchedDisposalError.tradeDate` rather than re-deriving it.
 */
const explainUnmatchedDisposal = (instrument: Instrument, tradeDate: IsoDate): string =>
  `Myyntiä ${instrument.name} (${instrument.isin}) päivältä ${tradeDate} ei voi käsitellä, ` +
  `koska instrumentille ei ole kirjattu ostotapahtumaa ennen tätä myyntiä: tuo puuttuvat ` +
  `ostotapahtumat tai poista myyntirivi.`;

/**
 * Explains why a holding could not be valued -- no price for `on`, or (for a non-EUR
 * instrument) no fx rate for `on`. Follows `explainUnmatchedDisposal`'s own wording
 * convention (names the instrument by ISIN/name, names the date, Finnish, user-facing).
 * C1: this is what used to fall through to a silent, fabricated `0,00 €` instead.
 */
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
 * Current holdings, valued as of `on`. `stale` is `true` whenever the price
 * actually used was not dated `on` itself (carried forward from an earlier
 * date, per `PriceLookup.priceDateOn`'s contract), was missing entirely, or
 * (C1) `valuationError` is set for any other reason -- either way the UI must
 * show the staleness badge rather than a number that looks as current, or as
 * complete, as it is not.
 *
 * Cost basis is resolved per instrument (`costBasisPerInstrument`), so one
 * instrument's `UnmatchedDisposalError` marks only that row's money fields
 * unknown via `costBasisError` -- it never 400s the whole response. Rejecting the
 * sale at commit time is deliberately not done instead: the ledger is append-only
 * and the user pages OP imports in newest-first order, so a page legitimately
 * contains a sale whose purchase is on a page not yet imported, and the state is
 * correct again once every page has landed.
 */
export const holdingsFor = (db: Db, userId: string, on: IsoDate): HoldingView[] => {
  const { txns, instruments: all, prices: lookup } = loadPortfolio(db, userId);
  const byId = new Map(all.map((instrument) => [instrument.id, instrument]));
  const costs = costBasisPerInstrument(txns, on);

  // First pass: everything EXCEPT `weight`, which needs the total across every other
  // row in this same result and so cannot be computed per-row in a single flatMap the
  // way the rest of this function's fields can.
  const rows = [...positionsAt(txns, on)].flatMap((entry) => {
    const [instrumentId, quantity] = entry;
    const instrument = byId.get(instrumentId);
    if (!instrument) return [];

    const price = lookup.priceOn(instrumentId, on);
    const priceDate = lookup.priceDateOn(instrumentId, on);
    const rate = instrument.currency === EUR ? null : lookup.fxOn(instrument.currency, on);

    // C1: no fabricated `zeroMoney(EUR)` fallback -- a holding this function cannot
    // honestly price or convert reports `null`, with `valuationError` saying why,
    // exactly like `costBasisError` already does for an unmatched disposal.
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
    // `outcome` is only ever absent for an instrument `positionsAt` did not
    // itself derive from `costBasisPerInstrument`'s own txn scan -- both walk
    // the same set of instrumentId-bearing transactions, so this defaults to
    // zero purely as a defensive fallback, matching this function's prior
    // behaviour for that case.
    const costEur = costBasisError ? null : outcome?.ok ? outcome.costEur : zeroMoney(EUR);

    // The single source of truth for "can this holding's market value be trusted at
    // all": null whenever `costBasisError` is set (see `HoldingView.costEur`'s doc --
    // an unmatched disposal can leave `quantity` negative, so a "market value" derived
    // from it would be nonsense) OR the price/fx lookup itself failed
    // (`nativeValueEur === null`). `valueEur`, `unrealisedEur` and `weight` all key off
    // this exact same value, so the three fields stay null/non-null in lockstep by
    // construction rather than three independently-written conditions drifting apart.
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

  // The weight denominator: the sum of every holding that COULD be valued (see
  // `HoldingView.weight`'s own doc for why an unvaluable holding is excluded from the
  // total rather than counted as a 0 contribution -- the same choice
  // `core/allocation.ts`'s `allocateBy` already made for slice totals).
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
      // `totalValuedEur.minor === 0n` guards a division that would otherwise be 0/0
      // (every valuable holding happens to be worth exactly zero, or there are none) --
      // an undefined ratio must not surface as a fabricated `NaN` or `0`.
      weight:
        row.valuedEur === null || totalValuedEur.minor === 0n
          ? null
          : Number(row.valuedEur.minor) / Number(totalValuedEur.minor),
      priceDate: row.priceDate,
      stale: row.valuationError !== null || row.priceDate !== on,
      costBasisError: row.costBasisError,
      valuationError: row.valuationError,
    }))
    .sort((a, b) => Number(b.valueEur ?? "0") - Number(a.valueEur ?? "0"));
};

/** One account's cash, and the household total, as the API reports them. */
export type CashReport = { readonly rows: CashView[]; readonly totalEur: string };

/** One account's cash, as the API and the chat tools report it. */
export type CashView = {
  readonly accountId: number;
  readonly accountName: string;
  readonly currency: Currency;
  readonly amount: string;
  /** Null when no fx rate is known for `on` -- the balance is real, its euro value is not. */
  readonly valueEur: string | null;
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
export const cashFor = (db: Db, userId: string, on: IsoDate): CashReport => {
  const { txns, prices } = loadPortfolio(db, userId);
  const names = new Map(
    db
      .select({ id: accounts.id, name: accounts.name })
      .from(accounts)
      .where(eq(accounts.userId, userId))
      .all()
      .map((row) => [row.id, row.name]),
  );

  const valued = valueCash(cashBalancesAt(txns, on), prices.fxOn, on);
  return {
    rows: valued.map((balance) => ({
      accountId: balance.accountId,
      accountName: names.get(balance.accountId) ?? `Tili ${balance.accountId}`,
      currency: balance.currency,
      amount: formatMoney(balance.amount),
      valueEur: balance.valueEur === null ? null : formatMoney(balance.valueEur),
    })),
    totalEur: formatMoney(totalCashEur(valued)),
  };
};

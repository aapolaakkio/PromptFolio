import { asc, eq, inArray } from "drizzle-orm";
import { costBasisPerInstrument, type CostBasisOutcome } from "../core/costbasis";
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

  return [...positionsAt(txns, on)]
    .flatMap(([instrumentId, quantity]) => {
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

      const holding: HoldingView = {
        instrumentId,
        isin: instrument.isin,
        name: instrument.name,
        kind: instrument.kind,
        currency: instrument.currency,
        quantity: formatQuantity(quantity),
        costEur: costEur === null ? null : formatMoney(costEur),
        valueEur:
          costBasisError === null && nativeValueEur !== null ? formatMoney(nativeValueEur) : null,
        unrealisedEur:
          costEur === null || nativeValueEur === null
            ? null
            : formatMoney(subMoney(nativeValueEur, costEur)),
        priceDate,
        stale: valuationError !== null || priceDate !== on,
        costBasisError,
        valuationError,
      };
      return [holding];
    })
    .sort((a, b) => Number(b.valueEur ?? "0") - Number(a.valueEur ?? "0"));
};

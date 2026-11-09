import { eq } from "drizzle-orm";

import { buildLots } from "../core/costbasis.ts";
import { positionsAt } from "../core/ledger.ts";
import {
  addMoney,
  formatMoney,
  formatQuantity,
  mulMoney,
  toEur,
  zeroMoney,
  EUR,
  type Money,
} from "../core/money.ts";
import { cashBalancesAt } from "../core/cash.ts";
import type { OstValuation } from "../core/tax/ost.ts";
import { daysBetween, isPriceStale } from "../core/staleness.ts";
import { taxYear } from "../core/tax/year.ts";
import type { Instrument, IsoDate } from "../core/types.ts";
import type { Db } from "./db/index.ts";
import { accounts } from "./db/schema.ts";
import { loadPortfolio } from "./valuation.ts";

/** Largest price gap that still counts as the market being closed (Easter, Christmas); a hand-recorded price months from its neighbour stays visible as a gap. */
const MAX_TRADING_GAP_DAYS = 5;

/** The tax year as reported: decimal strings, instruments named (core returns ids, which a user must never see). */
export type TaxDisposalView = {
  readonly instrument: string;
  readonly isin: string;
  readonly accountName: string;
  readonly acquiredOn: IsoDate;
  readonly soldOn: IsoDate;
  readonly quantity: string;
  readonly netProceedsEur: string;
  readonly grossProceedsEur: string;
  readonly actualCostEur: string;
  readonly deemedCostEur: string;
  readonly deemedPercent: number;
  readonly actualGainEur: string;
  readonly deemedGainEur: string;
  readonly method: "actual" | "deemed";
  readonly gainEur: string;
};

type TaxDividendView = {
  readonly instrument: string | null;
  readonly accountName: string;
  readonly paidOn: IsoDate;
  readonly grossEur: string;
  readonly withheldEur: string;
  readonly taxableEur: string;
  /** False when the ledger holds no withholding for this payment. See `core/tax/dividends.ts`. */
  readonly withholdingRecorded: boolean;
};

type OstWithdrawalView = {
  readonly withdrawnOn: IsoDate;
  readonly amountEur: string;
  readonly withheldEur: string;
  readonly valueEur: string | null;
  readonly profitEur: string | null;
  readonly taxableEur: string | null;
  /** The oldest price date the valuation leaned on when a holding had none for the withdrawal's day; null when all were current. */
  readonly pricedFrom: IsoDate | null;
  /** User-facing, naming the instrument and date. Null when computed. */
  readonly blockedBy: string | null;
  /** The instrument whose price this row lacks for its own day (missing or carried forward), so the screen can offer to record one: it has usually been sold and appears on no other screen. */
  readonly priceInstrument: {
    readonly id: number;
    readonly name: string;
    readonly currency: string;
  } | null;
};

type OstView = {
  readonly accountName: string;
  readonly withdrawals: readonly OstWithdrawalView[];
  readonly depositedEur: string;
  readonly capRemainingEur: string;
  readonly incomplete: boolean;
};

type CarriedLossView = {
  readonly fromYear: number;
  readonly amountEur: string;
};

export type TaxYearView = {
  readonly year: number;
  readonly disposals: readonly TaxDisposalView[];
  readonly totalSalePriceEur: string;
  readonly exempt: boolean;
  readonly gainsEur: string;
  readonly lossesEur: string;
  readonly netEur: string;
  readonly lossesUsedEur: string;
  readonly lossCarriedIn: readonly CarriedLossView[];
  readonly lossCarriedOut: readonly CarriedLossView[];
  readonly dividends: readonly TaxDividendView[];
  readonly dividendTaxableEur: string;
  readonly ost: readonly OstView[];
  /** What the figures were derived from, so a changed number is explicable. */
  readonly source: {
    readonly transactions: number;
    readonly earliest: IsoDate | null;
  };
};

/** Names an unvaluable OST holding the way the rest of the app names its gaps. */
const explainNoPrice = (instrument: Instrument | undefined, on: IsoDate): string =>
  instrument === undefined
    ? `The equity savings account cannot be valued on ${on}, because one holding has no price.`
    : `${instrument.name} (${instrument.isin}) has no price on ${on}, ` +
      `so the equity savings account's value and the taxable part of the withdrawal cannot be computed. ` +
      `Record a price for that date and this row will compute.`;

/** Why a withdrawal after an unvaluable one cannot be computed either: the gap leaves deposits too high, so it would read as less profitable than it was. */
const explainEarlierGap = (since: IsoDate): string =>
  `The taxable part of the earlier withdrawal (${since}) could not be computed, so the deposits are ` +
  `too high and this withdrawal's profit share cannot be computed reliably. Record the price missing ` +
  `on that earlier date and this row will compute too.`;

export const taxYearFor = async (db: Db, userId: string, year: number): Promise<TaxYearView> => {
  const { txns, instruments, prices, nextPriceDateAfter } = await loadPortfolio(db, userId);
  const owned = await db.select().from(accounts).where(eq(accounts.userId, userId)).all();
  const nameOf = new Map(owned.map((account) => [account.id, account.name]));
  const instrumentById = new Map(instruments.map((i) => [i.id, i]));
  const ostAccountIds = new Set<number>(
    owned.filter((account) => account.accountType === "ost").map((account) => account.id),
  );

  /** An OST's value immediately before a transaction: positions priced on the day plus cash. A position with no price stops the valuation (a total missing a holding is unknown, not smaller). "Immediately before" keeps the withdrawal being apportioned in the total. */
  const ostValueAt = (accountId: number, on: IsoDate, beforeTxnId: number): OstValuation => {
    const accountTxns = txns.filter(
      (t) =>
        t.accountId === accountId &&
        (t.tradeDate < on || (t.tradeDate === on && t.id < beforeTxnId)),
    );
    let value = zeroMoney(EUR);
    // The oldest price the valuation leaned on: one recorded price makes every later date compute, so without this a figure can rest on a months-old quote silently.
    let pricedFrom: IsoDate | null = null;
    let pricedFromInstrumentId: number | null = null;
    for (const [instrumentId, quantity] of positionsAt(accountTxns, on)) {
      if (quantity.scaled === 0n) continue;
      const price = prices.priceOn(instrumentId, on);
      if (price === null) return { ok: false, instrumentId };
      const instrument = instrumentById.get(instrumentId);
      const priceDate = prices.priceDateOn(instrumentId, on);
      // A market holiday is not a missing price: a bar within days after this date but none on it means the exchange was shut (a Xetra listing on Whit Monday). A genuinely sparse source still reads stale.
      const nextPrice = nextPriceDateAfter(instrumentId, on);
      const marketWasShut =
        nextPrice !== null && daysBetween(on, nextPrice) <= MAX_TRADING_GAP_DAYS;
      // Markets close and a fund's NAV publishes a weekday behind, so Friday's close is the freshest price a Sunday withdrawal can have. `isPriceStale` is the holdings badge's rule; comparing dates directly made every weekend look like a gap.
      if (
        priceDate !== null &&
        !marketWasShut &&
        isPriceStale({ kind: instrument?.kind ?? "stock", priceDate, on }) &&
        (pricedFrom === null || priceDate < pricedFrom)
      ) {
        pricedFrom = priceDate;
        pricedFromInstrumentId = instrumentId;
      }
      const native = mulMoney(price, quantity);
      if (instrument === undefined || instrument.currency === EUR) {
        value = addMoney(value, native);
        continue;
      }
      const rate = prices.fxOn(instrument.currency, on);
      if (rate === null) return { ok: false, instrumentId };
      value = addMoney(value, toEur(native, rate));
    }
    for (const balance of cashBalancesAt(accountTxns, on)) {
      if (balance.currency !== EUR) {
        const rate = prices.fxOn(balance.currency, on);
        if (rate === null) return { ok: false, instrumentId: 0 };
        value = addMoney(value, toEur(balance.amount, rate));
        continue;
      }
      value = addMoney(value, balance.amount);
    }
    return { ok: true, valueEur: value, pricedFrom, pricedFromInstrumentId };
  };

  // Cost basis uses every transaction the user owns: FIFO needs purchases from earlier years.
  const { disposals } = buildLots(txns.filter((t) => t.instrumentId !== null));
  const computed = taxYear({
    txns,
    disposals,
    ostAccountIds,
    ostValueAt,
    year,
  });

  const money = (m: Money): string => formatMoney(m);

  return {
    year,
    disposals: computed.disposals.map((row): TaxDisposalView => {
      const instrument = instrumentById.get(row.instrumentId);
      return {
        instrument: instrument?.name ?? "Unknown instrument",
        isin: instrument?.isin ?? "",
        accountName: nameOf.get(row.accountId) ?? "Unknown account",
        acquiredOn: row.acquiredOn,
        soldOn: row.soldOn,
        quantity: formatQuantity(row.quantity),
        netProceedsEur: money(row.netProceedsEur),
        grossProceedsEur: money(row.grossProceedsEur),
        actualCostEur: money(row.actualCostEur),
        deemedCostEur: money(row.deemedCostEur),
        deemedPercent: Number(row.deemedPercent),
        actualGainEur: money(row.actualGainEur),
        deemedGainEur: money(row.deemedGainEur),
        method: row.method,
        gainEur: money(row.gainEur),
      };
    }),
    totalSalePriceEur: money(computed.totalSalePriceEur),
    exempt: computed.exempt,
    gainsEur: money(computed.gainsEur),
    lossesEur: money(computed.lossesEur),
    netEur: money(computed.netEur),
    lossesUsedEur: money(computed.lossesUsedEur),
    lossCarriedIn: computed.lossCarriedIn.map((loss) => ({
      fromYear: loss.fromYear,
      amountEur: money(loss.amountEur),
    })),
    lossCarriedOut: computed.lossCarriedOut.map((loss) => ({
      fromYear: loss.fromYear,
      amountEur: money(loss.amountEur),
    })),
    dividends: computed.dividends.map((row): TaxDividendView => {
      const instrument =
        row.instrumentId === null ? undefined : instrumentById.get(row.instrumentId);
      return {
        instrument: instrument?.name ?? null,
        accountName: nameOf.get(row.accountId) ?? "Unknown account",
        paidOn: row.paidOn,
        grossEur: money(row.grossEur),
        withheldEur: money(row.withheldEur),
        taxableEur: money(row.taxableEur),
        withholdingRecorded: row.withholdingRecorded,
      };
    }),
    dividendTaxableEur: money(computed.dividendTaxableEur),
    ost: computed.ost.map((entry): OstView => ({
      accountName: nameOf.get(entry.accountId) ?? "Equity savings account",
      withdrawals: entry.report.withdrawals.map((withdrawal): OstWithdrawalView => {
        const { outcome } = withdrawal;
        return {
          withdrawnOn: withdrawal.withdrawnOn,
          amountEur: money(withdrawal.amountEur),
          valueEur: outcome.ok ? money(outcome.valueEur) : null,
          profitEur: outcome.ok ? money(outcome.profitEur) : null,
          taxableEur: outcome.ok ? money(outcome.taxableEur) : null,
          pricedFrom: outcome.ok ? outcome.pricedFrom : null,
          withheldEur: money(withdrawal.withheldEur),
          priceInstrument: ((id) =>
            id === null
              ? null
              : ((found) =>
                  found === undefined
                    ? null
                    : { id: found.id, name: found.name, currency: found.currency })(
                  instrumentById.get(id),
                ))(
            outcome.ok
              ? outcome.pricedFromInstrumentId
              : outcome.reason === "no-price"
                ? outcome.instrumentId
                : null,
          ),
          blockedBy: outcome.ok
            ? null
            : outcome.reason === "no-price"
              ? explainNoPrice(instrumentById.get(outcome.instrumentId), withdrawal.withdrawnOn)
              : explainEarlierGap(outcome.since),
        };
      }),
      depositedEur: money(entry.report.depositedEur),
      capRemainingEur: money(entry.report.capRemainingEur),
      incomplete: entry.report.incomplete,
    })),
    source: {
      transactions: txns.length,
      earliest: txns[0]?.tradeDate ?? null,
    },
  };
};

/** The years that have any taxable event, newest first. */
export const taxYearsFor = async (db: Db, userId: string): Promise<number[]> => {
  const { txns } = await loadPortfolio(db, userId);
  const years = new Set<number>();
  for (const t of txns) {
    if (t.type === "SELL" || t.type === "DIVIDEND" || t.type === "WITHDRAWAL") {
      years.add(Number(t.tradeDate.slice(0, 4)));
    }
  }
  return [...years].sort((a, b) => b - a);
};

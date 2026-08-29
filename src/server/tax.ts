import { eq } from "drizzle-orm";

import { buildLots } from "../core/costbasis";
import { positionsAt } from "../core/ledger";
import {
  addMoney,
  formatMoney,
  formatQuantity,
  mulMoney,
  toEur,
  zeroMoney,
  EUR,
  type Money,
} from "../core/money";
import { cashBalancesAt } from "../core/cash";
import type { OstValuation } from "../core/tax/ost";
import { taxYear } from "../core/tax/year";
import type { Instrument, IsoDate } from "../core/types";
import type { getDb } from "./db";
import { accounts } from "./db/schema";
import { loadPortfolio } from "./valuation";

type Db = ReturnType<typeof getDb>["db"];

/**
 * The tax year as the API reports it: decimal strings, and instruments named
 * rather than numbered.
 *
 * `core/tax` returns instrument ids because it never sees a database row. A
 * user must never be shown an internal numeric id -- the convention
 * `explainUnmatchedDisposal` already follows -- so the naming happens here.
 */
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

export type TaxDividendView = {
  readonly instrument: string | null;
  readonly accountName: string;
  readonly paidOn: IsoDate;
  readonly grossEur: string;
  readonly withheldEur: string;
  readonly taxableEur: string;
  /** False when the ledger holds no withholding for this payment. See `core/tax/dividends.ts`. */
  readonly withholdingRecorded: boolean;
};

export type OstWithdrawalView = {
  readonly withdrawnOn: IsoDate;
  /** What left the account, tax withheld included. */
  readonly amountEur: string;
  /** Capital income tax the broker withheld -- evidence to check our own figure against. */
  readonly withheldEur: string;
  readonly valueEur: string | null;
  readonly profitEur: string | null;
  readonly taxableEur: string | null;
  /**
   * The oldest price date the valuation leaned on, when a holding had none for
   * the withdrawal's own day. Null when every price was current -- see
   * `core/tax/ost.ts`'s `OstValuation.pricedFrom`.
   */
  readonly pricedFrom: IsoDate | null;
  /** Finnish, user-facing, naming the instrument and date. Null when computed. */
  readonly blockedBy: string | null;
  /**
   * The instrument whose price this row depends on and does not have for its
   * own day -- missing entirely, or carried forward from earlier. Carried so
   * the screen can offer to record one: the holding has usually been sold by
   * now, so it appears on no other screen, and an instruction to record a price
   * would otherwise name a form the user cannot reach.
   */
  readonly priceInstrument: {
    readonly id: number;
    readonly name: string;
    readonly currency: string;
  } | null;
};

export type OstView = {
  readonly accountName: string;
  readonly withdrawals: readonly OstWithdrawalView[];
  readonly depositedEur: string;
  readonly capRemainingEur: string;
  readonly incomplete: boolean;
};

export type CarriedLossView = {
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
    ? `Osakesäästötilin arvoa ei voi laskea päivälle ${on}, koska yhdelle omistukselle ei ole hintaa.`
    : `Instrumentille ${instrument.name} (${instrument.isin}) ei ole hintaa päivälle ${on}, ` +
      `joten osakesäästötilin arvoa ja noston veronalaista osuutta ei voi laskea. ` +
      `Kirjaa hinta kyseiselle päivälle, niin rivi laskeutuu.`;

/**
 * Why a withdrawal that follows an unvaluable one cannot be computed either.
 *
 * Said plainly rather than shown as a figure: the earlier gap leaves the
 * account's deposits too high by an unknown amount, so this withdrawal reads as
 * less profitable than it was -- as not profitable at all, in the real case
 * that exposed it, on a withdrawal the broker had withheld tax from.
 */
const explainEarlierGap = (since: IsoDate): string =>
  `Aiemman noston (${since}) veronalaista osuutta ei voitu laskea, joten talletusten määrä on ` +
  `liian suuri eikä tämän noston voitto-osuutta voi laskea luotettavasti. Kirjaa aiemmalta ` +
  `päivältä puuttuva hinta, niin tämäkin rivi laskeutuu.`;

export const taxYearFor = (db: Db, userId: string, year: number): TaxYearView => {
  const { txns, instruments, prices } = loadPortfolio(db, userId);
  const owned = db.select().from(accounts).where(eq(accounts.userId, userId)).all();
  const nameOf = new Map(owned.map((account) => [account.id, account.name]));
  const instrumentById = new Map(instruments.map((i) => [i.id, i]));
  const ostAccountIds = new Set<number>(
    owned.filter((account) => account.accountType === "ost").map((account) => account.id),
  );

  /**
   * An OST's fair market value immediately before transaction `beforeTxnId`:
   * its positions priced on the day, plus its cash. A position with no price
   * stops the whole valuation -- a total missing one holding is not a smaller
   * total, it is an unknown one.
   *
   * "Immediately before" is what makes the apportionment right. The ledger is
   * ordered by date then id, so everything strictly earlier in that order has
   * happened and everything later has not -- including the withdrawal being
   * apportioned, whose own cash must not be missing from the total it is
   * measured against.
   */
  const ostValueAt = (accountId: number, on: IsoDate, beforeTxnId: number): OstValuation => {
    const accountTxns = txns.filter(
      (t) =>
        t.accountId === accountId &&
        (t.tradeDate < on || (t.tradeDate === on && t.id < beforeTxnId)),
    );
    let value = zeroMoney(EUR);
    // The oldest price the valuation leaned on, when any holding had none for
    // the day itself. One recorded price makes every later date compute, so
    // without this a figure can rest on a months-old quote and not say so.
    let pricedFrom: IsoDate | null = null;
    let pricedFromInstrumentId: number | null = null;
    for (const [instrumentId, quantity] of positionsAt(accountTxns, on)) {
      if (quantity.scaled === 0n) continue;
      const price = prices.priceOn(instrumentId, on);
      if (price === null) return { ok: false, instrumentId };
      const priceDate = prices.priceDateOn(instrumentId, on);
      if (
        priceDate !== null &&
        priceDate !== on &&
        (pricedFrom === null || priceDate < pricedFrom)
      ) {
        pricedFrom = priceDate;
        pricedFromInstrumentId = instrumentId;
      }
      const instrument = instrumentById.get(instrumentId);
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

  // Cost basis is built from every transaction the user owns, not only the
  // year's: FIFO needs the purchases, which are usually in earlier years.
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
        instrument: instrument?.name ?? "Tuntematon instrumentti",
        isin: instrument?.isin ?? "",
        accountName: nameOf.get(row.accountId) ?? "Tuntematon tili",
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
        accountName: nameOf.get(row.accountId) ?? "Tuntematon tili",
        paidOn: row.paidOn,
        grossEur: money(row.grossEur),
        withheldEur: money(row.withheldEur),
        taxableEur: money(row.taxableEur),
        withholdingRecorded: row.withholdingRecorded,
      };
    }),
    dividendTaxableEur: money(computed.dividendTaxableEur),
    ost: computed.ost.map((entry): OstView => ({
      accountName: nameOf.get(entry.accountId) ?? "Osakesäästötili",
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
export const taxYearsFor = (db: Db, userId: string): number[] => {
  const { txns } = loadPortfolio(db, userId);
  const years = new Set<number>();
  for (const t of txns) {
    if (t.type === "SELL" || t.type === "DIVIDEND" || t.type === "WITHDRAWAL") {
      years.add(Number(t.tradeDate.slice(0, 4)));
    }
  }
  return [...years].sort((a, b) => b - a);
};

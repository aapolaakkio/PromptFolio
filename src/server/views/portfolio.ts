import { eq } from "drizzle-orm";

import { addMoney, negateMoney, subMoney } from "../../core/money.ts";
import { firstBalanceDate, owedOn, owedSeries } from "../../core/debts.ts";
import { debtBalancesFor } from "../debts.ts";
import { twr, xirr } from "../../core/returns.ts";
import { cashFlowFor } from "../spending/cashflow.ts";
import { cashlessAccountIds, notSpendingIds } from "../spending/internal.ts";
import { CATEGORY_LABELS, labelForCategory } from "../spending/categories.ts";
import { monthlyByCategory, monthlyFlows } from "../spending/monthly.ts";
import { classifiedTransactions } from "../spending/transactions.ts";
import { categoriseWith, rulesFor } from "../spending/rules.ts";
import { summariseSpending } from "../spending/summary.ts";
import { allocateBy, type Dimension } from "../../core/allocation.ts";
import {
  availableCashEur,
  cashBalancesAt,
  cashSeries,
  lockedCashEur,
  totalCashEur,
  valueCash,
} from "../../core/cash.ts";
import {
  accountsMissingCashRecord,
  fundingCashFlows,
  investedCashFlows,
  negativePositionIds,
} from "../../core/ledger.ts";
import { EUR, formatMoney, zeroMoney } from "../../core/money.ts";
import { investedSeries, valueSeries } from "../../core/returns.ts";
import type { IsoDate } from "../../core/types.ts";
import type { Db } from "../db/index.ts";
import { accounts } from "../db/schema.ts";
import { cashFor, loadPortfolio, withAvailability } from "../valuation.ts";

/** The view logic behind the screens, as functions of database, user and arguments rather than only reachable through a Request. */

/** Payment labels, not payees: when a statement has no payee, a rule on one would catch every payment of that kind. */
const DAY_MS = 86_400_000;

/** The calendar day before `date`, where a window's opening value is read. */
const dayBefore = (date: IsoDate): IsoDate =>
  new Date(Date.parse(date) - DAY_MS).toISOString().slice(0, 10);

const LABEL_ONLY: ReadonlySet<string> = new Set([
  "PKORTTIMAKSU",
  "MAKSUPALVELU",
  "TILISIIRTO",
  "PANO",
  "OTTO",
  "PALKKA",
  "LUOTON MAKSU",
  "TALLETUSKORKO",
  "PERUUTUS",
  "ETUUS",
  "NIMETÖN",
]);

/** The earliest day the ledger records, or undefined when it records nothing. */
const earliestTradeDate = (txns: readonly { tradeDate: IsoDate }[]): IsoDate | undefined =>
  txns.reduce<IsoDate | undefined>(
    (earliest, txn) =>
      earliest === undefined || txn.tradeDate < earliest ? txn.tradeDate : earliest,
    undefined,
  );

export const cashView = (db: Db, userId: string, on: IsoDate) => {
  return cashFor(db, userId, on);
};

export const valueSeriesView = async (
  db: Db,
  userId: string,
  from: IsoDate | undefined,
  to: IsoDate,
) => {
  const { investedTxns, cashTxns, instruments, prices } = await loadPortfolio(db, userId);
  // Without a start, the ledger's first day: a fixed floor like 1900 draws a century of flat zero. Both series are one point per day over the same range.
  const start = from ?? earliestTradeDate(investedTxns) ?? to;
  const invested = investedSeries(investedTxns, start, to);
  const cash = cashSeries(cashTxns, prices.fxOn, start, to);
  const owed = owedSeries(await debtBalancesFor(db, userId), start, to);
  return valueSeries(investedTxns, instruments, prices, start, to).map((point, index) => {
    const cashEur = cash[index]?.cashEur ?? zeroMoney(EUR);
    const owedEur = owed[index]?.owedEur ?? zeroMoney(EUR);
    return {
      date: point.date,
      valueEur: formatMoney(point.valueEur),
      investedEur: formatMoney(invested[index]?.investedEur ?? zeroMoney(EUR)),
      cashEur: formatMoney(cashEur),
      owedEur: formatMoney(owedEur),
      netEur: formatMoney(subMoney(addMoney(point.valueEur, cashEur), owedEur)),
      stale: point.stale,
      // A holding with no price yet that day is valued at cost; the chart draws these days apart.
      costValued: point.costValuedInstrumentIds.length > 0,
      // Instruments excluded from this day's valueEur (negative net position from an unmatched disposal); /api/holdings carries their ISIN and name.
      excludedInstrumentIds: point.excludedInstrumentIds,
    };
  });
};

export const allocationView = async (db: Db, userId: string, dimension: Dimension, on: IsoDate) => {
  const { txns, cashTxns, instruments, prices } = await loadPortfolio(db, userId);
  const byId = new Map(instruments.map((instrument) => [instrument.id, instrument]));

  // Cash is part of the allocation: a portfolio a fifth in an unspent deposit is not 100 % invested.
  const cash = await withAvailability(
    db,
    userId,
    valueCash(cashBalancesAt(cashTxns, on), prices.fxOn, on),
    on,
  );
  const { slices, excludedInstrumentIds } = allocateBy(
    txns,
    instruments,
    prices,
    on,
    dimension,
    cash,
  );

  // A holding leaves every slice for one of two visible reasons: it could not be priced, or its position is negative.
  const excludedIds = new Set([...negativePositionIds(txns, on), ...excludedInstrumentIds]);
  const excludedInstruments = [...excludedIds].flatMap((instrumentId) => {
    const instrument = byId.get(instrumentId);
    return instrument ? [{ instrumentId, isin: instrument.isin, name: instrument.name }] : [];
  });

  return {
    slices: slices.map((slice) => ({
      key: slice.key,
      label: slice.label,
      valueEur: formatMoney(slice.valueEur),
      weight: slice.weight,
    })),
    excludedInstruments,
  };
};

export const cashFlowView = async (
  db: Db,
  userId: string,
  from: IsoDate,
  to: IsoDate,
  by: "category" | "counterparty" = "category",
) => {
  const { txns, bankAccountIds } = await loadPortfolio(db, userId);
  const bank = new Set(bankAccountIds);
  // Every non-bank account holds investments; its own deposits are the reliable record of money moved in.
  const invested = new Set(
    txns.map((txn) => txn.accountId).filter((accountId) => !bank.has(accountId)),
  );

  return cashFlowFor({
    txns,
    rules: await rulesFor(db, userId),
    bankAccountIds: bank,
    investedAccountIds: invested,
    cashlessInvestedAccountIds: cashlessAccountIds(txns, bank),
    from,
    to,
    by,
  });
};

export const monthlyView = async (db: Db, userId: string, from: IsoDate, to: IsoDate) => {
  const { txns, bankAccountIds } = await loadPortfolio(db, userId);
  const shared = {
    txns,
    rules: await rulesFor(db, userId),
    bankAccountIds: new Set(bankAccountIds),
    from,
    to,
  };
  return {
    months: monthlyFlows(shared),
    // The same months by category, to show whether one is creeping up (a single Sankey cannot).
    byCategory: monthlyByCategory({
      ...shared,
      labelFor: labelForCategory,
    }),
  };
};

export const classifiedView = async (db: Db, userId: string, from: IsoDate, to: IsoDate) => {
  const { txns, bankAccountIds } = await loadPortfolio(db, userId);
  const bank = new Set(bankAccountIds);
  return {
    from,
    to,
    transactions: classifiedTransactions({
      txns,
      rules: await rulesFor(db, userId),
      bankAccountIds: bank,
      cashlessAccountIds: cashlessAccountIds(txns, bank),
      labelFor: labelForCategory,
      from,
      to,
    }),
  };
};

export const uncategorisedView = async (db: Db, userId: string, from: IsoDate, to: IsoDate) => {
  const { txns, bankAccountIds } = await loadPortfolio(db, userId);
  const bank = new Set(bankAccountIds);
  const moved = notSpendingIds(txns, bank);
  const rules = await rulesFor(db, userId);

  // Only what no rule matched: the list a person works through to teach the app.
  const unmatched = txns.filter(
    (txn) =>
      bank.has(txn.accountId) &&
      !moved.has(txn.id) &&
      categoriseWith(txn.note ?? "", rules) === "other",
  );

  const summary = summariseSpending(unmatched, { from, to, by: "counterparty", rules });
  return {
    from,
    to,
    totalEur: summary.totalEur,
    merchants: summary.groups.map((group) => ({
      name: group.label,
      totalEur: group.totalEur,
      count: group.count,
      // A row with no payee is grouped under its own label ("MAKSUPALVELU"); a rule on that would file every bill payment alike, so do not offer one.
      payeeKnown: !LABEL_ONLY.has(group.label.toUpperCase()),
    })),
    categories: Object.entries(CATEGORY_LABELS).map(([id, label]) => ({ id, label })),
  };
};

export const spendingView = async (
  db: Db,
  userId: string,
  from: IsoDate,
  to: IsoDate,
  by: "category" | "counterparty",
  limit: number,
) => {
  const { txns, bankAccountIds } = await loadPortfolio(db, userId);
  const bank = new Set(bankAccountIds);
  // A payment that funded a fund purchase, moved money to own savings or settled the card is not spending.
  const moved = notSpendingIds(txns, bank);
  return summariseSpending(
    txns.filter((txn) => bank.has(txn.accountId) && !moved.has(txn.id)),
    { from, to, by, limit, rules: await rulesFor(db, userId) },
  );
};

export const returnsView = async (db: Db, userId: string, from: IsoDate, to: IsoDate) => {
  const { cashTxns, investedTxns, instruments, prices } = await loadPortfolio(db, userId);
  const byId = new Map(instruments.map((instrument) => [instrument.id, instrument]));
  // Invested transactions only: bank rows would read every grocery payment as capital withdrawn from XIRR's DEPOSIT/WITHDRAWAL flows.
  const series = valueSeries(investedTxns, instruments, prices, from, to);
  // xirr measures when the investor moved cash, twr measures positions. Chosen per account from whichever record it keeps: mixing one broker's holdings with another's deposits reported three times the true rate.
  const mwrFlows = fundingCashFlows(investedTxns).filter(
    (flow) => flow.date >= from && flow.date <= to,
  );
  const twrFlows = investedCashFlows(investedTxns).filter(
    (flow) => flow.date >= from && flow.date <= to,
  );
  const final = series.at(-1);

  // The value already held going into `from`, as an implicit contribution: without it xirr sees the final value appear from nothing. Read from the day before `from`, which keeps it a no-op for a since-inception range (a deposit dated `from` is not doubled).
  const opening = valueSeries(
    investedTxns,
    instruments,
    prices,
    dayBefore(from),
    dayBefore(from),
  )[0];

  // xirr takes contributions as NEGATIVE and withdrawals as POSITIVE; the ledger signs them the other way, so negate with `negateMoney` (a format/parse round-trip breaks on a negative WITHDRAWAL).
  let mwr: number | null = null;
  try {
    mwr = final
      ? xirr(
          [
            ...(opening ? [{ date: from, amountEur: negateMoney(opening.valueEur) }] : []),
            ...mwrFlows.map((flow) => ({
              date: flow.date,
              amountEur: negateMoney(flow.amountEur),
            })),
          ],
          { date: final.date, amountEur: final.valueEur },
        )
      : null;
  } catch {
    // xirr throws with under two flows, one sign only, or no convergence: the honest answer is "unknown" (null, shown as "—"), not a fabricated rate.
    mwr = null;
  }

  // Instruments excluded on ANY day in [from, to], not just the last: a mid-window gap can drive `twr` to null. Deduped and enriched with isin/name like /api/allocation's `excludedInstruments`.
  const ownedAccounts = new Map(
    (
      await db
        .select({ id: accounts.id, name: accounts.name })
        .from(accounts)
        .where(eq(accounts.userId, userId))
        .all()
    ).map((row) => [row.id, row.name] as const),
  );

  const excludedIds = new Set(series.flatMap((point) => point.excludedInstrumentIds));
  const excludedInstruments = [...excludedIds].flatMap((instrumentId) => {
    const instrument = byId.get(instrumentId);
    return instrument ? [{ instrumentId, isin: instrument.isin, name: instrument.name }] : [];
  });

  // Cash on the last day and the total including it, so the client does no money arithmetic. Returns stay position-only: an unspent deposit is not underperformance.
  const cashAtEnd = await withAvailability(
    db,
    userId,
    valueCash(cashBalancesAt(cashTxns, to), prices.fxOn, to),
    to,
  );
  const cashEur = totalCashEur(cashAtEnd);
  const positionsEur = final ? final.valueEur : zeroMoney(EUR);
  const balances = await debtBalancesFor(db, userId);
  const owedEur = owedOn(balances, to);
  const valueWithCashEur = addMoney(positionsEur, cashEur);

  return {
    from,
    to,
    valueEur: formatMoney(positionsEur),
    cashEur: formatMoney(cashEur),
    // What of that cash is spendable, and what is locked until maturity.
    availableCashEur: formatMoney(availableCashEur(cashAtEnd)),
    lockedCashEur: formatMoney(lockedCashEur(cashAtEnd)),
    valueWithCashEur: formatMoney(valueWithCashEur),
    owedEur: formatMoney(owedEur),
    netWorthEur: formatMoney(subMoney(valueWithCashEur, owedEur)),
    debtsKnownFrom: firstBalanceDate(balances),
    stale: final?.stale ?? false,
    twr: twr(series, twrFlows),
    mwr,
    excludedInstruments,
    /** Accounts whose broker exports no cash movements, so contributions are inferred from purchases and the money-weighted figure means something slightly different. */
    accountsMissingCashRecord: accountsMissingCashRecord(investedTxns).flatMap((accountId) => {
      const account = ownedAccounts.get(accountId);
      return account ? [{ accountId, name: account }] : [];
    }),
  };
};

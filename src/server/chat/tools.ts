import { z } from "zod";

import {
  type ChatTool,
  DEFAULT_TXN_LIMIT,
  type Db,
  IsoDateSchema,
  MAX_SERIES_POINTS,
  today,
} from "./tool-types.ts";
import { buildMoneyTools } from "./tools-money.ts";
import { buildRuleTools } from "./tools-rules.ts";

import { allocateBy } from "../../core/allocation.ts";
import { cashBalancesAt, valueCash } from "../../core/cash.ts";
import { notSpendingIds } from "../spending/internal.ts";
import { categoriseWith, rulesFor } from "../spending/rules.ts";
import { summariseSpending } from "../spending/summary.ts";
import { calculate } from "./calculator.ts";
import { fundingCashFlows, investedCashFlows } from "../../core/ledger.ts";
import { formatMoney, formatQuantity, negateMoney } from "../../core/money.ts";
import { twr, valueSeries, xirr } from "../../core/returns.ts";
import { driftReportFor, feeReportFor } from "../rebalance.ts";
import { taxYearFor, taxYearsFor } from "../tax.ts";
import { cashFor, holdingsFor, loadPortfolio } from "../valuation.ts";

export { type ChatTool, type JsonValue, type ToolArgs, type ToolResult } from "./tool-types.ts";

const NoArgs = z.object({}).strict();
const OnDate = z.object({ on: IsoDateSchema.optional() }).strict();
const Range = z.object({ from: IsoDateSchema.optional(), to: IsoDateSchema.optional() }).strict();
const Grouping = z
  .object({ by: z.enum(["kind", "currency", "account", "instrument"]).optional() })
  .strict();
const TaxYear = z.object({ year: z.number().int().min(1990).max(2100).optional() }).strict();
const Allocation = z
  .object({
    on: IsoDateSchema.optional(),
    dimension: z.enum(["kind", "currency", "account", "instrument"]).optional(),
  })
  .strict();
const Spending = z
  .object({
    from: IsoDateSchema.optional(),
    to: IsoDateSchema.optional(),
    groupBy: z.enum(["category", "counterparty"]).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict();
const Calculation = z
  .object({
    operation: z.enum(["sum", "subtract", "multiply", "divide", "percent", "average"]),
    values: z.array(z.string()).min(1).max(200),
  })
  .strict();
const Transactions = z
  .object({
    from: IsoDateSchema.optional(),
    to: IsoDateSchema.optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();

export const buildChatTools = (db: Db, userId: string): ChatTool[] => [
  {
    name: "get_holdings",
    description:
      "Current holdings: quantity, cost basis, market value, return and weight. " +
      "Pass 'on' for the position on a past date.",
    schema: OnDate,
    run: async (input) => {
      const { on = today() } = OnDate.parse(input);
      const rows = await holdingsFor(db, userId, on);
      return {
        asOf: on,
        stale: rows.some((row) => row.stale),
        // Named so an answer about total worth does not add cash in prose; get_cash breaks it down.
        cashEur: (await cashFor(db, userId, on)).totalEur,
        holdings: rows.map((row) => ({
          name: row.name,
          isin: row.isin,
          kind: row.kind,
          currency: row.currency,
          quantity: row.quantity,
          costEur: row.costEur,
          valueEur: row.valueEur,
          unrealisedEur: row.unrealisedEur,
          weight: row.weight,
          // Named: a silently omitted holding reads as one the owner does not have.
          unvaluableReason: row.valuationError ?? row.costBasisError?.message ?? null,
        })),
      };
    },
  },
  {
    name: "get_cash",
    description:
      "Uninvested cash by account and currency. Separates money available immediately " +
      "from fixed-term deposits that cannot be withdrawn before maturity. " +
      "Cash is included in portfolio value and allocation, but not in return figures.",
    schema: OnDate,
    run: async (input) => {
      const { on = today() } = OnDate.parse(input);
      const { rows, totalEur, availableEur, lockedEur } = await cashFor(db, userId, on);
      return {
        asOf: on,
        totalEur,
        // Fixed-term deposits are owned but not spendable; one figure would misanswer "what do I have available".
        availableEur,
        lockedEur,
        balances: rows.map((row) => ({
          accountId: row.accountId,
          account: row.accountName,
          currency: row.currency,
          amount: row.amount,
          valueEur: row.valueEur,
          locked: row.locked,
          availableFrom: row.availableFrom,
        })),
        note:
          "Accounts whose data has no cash transactions at all (e.g. OP's securities " +
          "view) are not listed -- their balance cannot be derived. " +
          "locked: true means a fixed-term deposit that cannot be withdrawn before " +
          "the availableFrom date.",
      };
    },
  },

  {
    name: "get_allocation",
    description:
      "Allocation of holdings along the chosen dimension: kind, currency, " +
      "account or instrument.",
    schema: Allocation,
    run: async (input) => {
      const { on = today(), dimension = "kind" } = Allocation.parse(input);
      const { txns, cashTxns, instruments, prices } = await loadPortfolio(db, userId);
      const cash = valueCash(cashBalancesAt(cashTxns, on), prices.fxOn, on);
      const { slices, excludedInstrumentIds } = allocateBy(
        txns,
        instruments,
        prices,
        on,
        dimension,
        cash,
      );
      const byId = new Map(instruments.map((i) => [i.id, i.name]));
      return {
        asOf: on,
        dimension,
        slices: slices.map((slice) => ({
          label: slice.label,
          valueEur: formatMoney(slice.valueEur),
          weight: slice.weight,
        })),
        excluded: excludedInstrumentIds.map((id) => byId.get(id) ?? `#${id}`),
      };
    },
  },
  {
    name: "get_returns",
    description:
      "Return figures: time-weighted (twr) and own return (xirr, money-weighted), " +
      "and the portfolio value at the end of the period.",
    schema: Range,
    run: async (input) => {
      const { from = "2015-01-01", to = today() } = Range.parse(input);
      // Invested rows only: bank spending is not portfolio performance.
      const { investedTxns, instruments, prices } = await loadPortfolio(db, userId);
      const series = valueSeries(investedTxns, instruments, prices, from, to);
      const final = series.at(-1);
      const twrFlows = investedCashFlows(investedTxns).filter(
        (f) => f.date >= from && f.date <= to,
      );

      let mwr: number | null = null;
      try {
        const flows = fundingCashFlows(investedTxns)
          .filter((f) => f.date >= from && f.date <= to)
          .map((f) => ({ date: f.date, amountEur: negateMoney(f.amountEur) }));
        mwr = final ? xirr(flows, { date: final.date, amountEur: final.valueEur }) : null;
      } catch {
        // xirr may not converge or lack flows; "unknown" is the honest answer.
        mwr = null;
      }

      return {
        from,
        to,
        valueEur: final ? formatMoney(final.valueEur) : "0.00",
        stale: final?.stale ?? false,
        twr: twr(series, twrFlows),
        mwr,
        note:
          "twr is the time-weighted return over the whole period (not annualised). " +
          "mwr is the annual internal rate of return. null means the figure cannot be calculated.",
      };
    },
  },
  {
    name: "get_value_series",
    description:
      "Portfolio value over a period. Returns at most 60 evenly spaced points, " +
      "i.e. roughly monthly for a long period.",
    schema: Range,
    run: async (input) => {
      const { from = "2015-01-01", to = today() } = Range.parse(input);
      const { investedTxns, instruments, prices } = await loadPortfolio(db, userId);
      const series = valueSeries(investedTxns, instruments, prices, from, to);
      // Thinned, not truncated, so the shape survives; 60 points is enough and a daily series costs thousands of tokens re-sent each round trip.
      const step = Math.max(1, Math.ceil(series.length / MAX_SERIES_POINTS));
      return {
        from,
        to,
        points: series
          .filter((_, index) => index % step === 0 || index === series.length - 1)
          .map((point) => ({ date: point.date, valueEur: formatMoney(point.valueEur) })),
      };
    },
  },
  {
    name: "get_transactions",
    description:
      "Transactions in date order, newest first. Narrow with 'from'/'to' dates and " +
      "'limit' (default 25, at most 200).",
    schema: Transactions,
    run: async (input) => {
      const {
        from = "1900-01-01",
        to = today(),
        limit = DEFAULT_TXN_LIMIT,
      } = Transactions.parse(input);
      const { txns, instruments } = await loadPortfolio(db, userId);
      const byId = new Map(instruments.map((i) => [i.id, i.name]));
      const rows = txns
        .filter((t) => t.tradeDate >= from && t.tradeDate <= to)
        .sort((a, b) =>
          a.tradeDate === b.tradeDate ? b.id - a.id : a.tradeDate < b.tradeDate ? 1 : -1,
        )
        .slice(0, limit);
      return {
        from,
        to,
        // Said out loud so an answer cannot imply it saw everything.
        returned: rows.length,
        truncated: rows.length === limit,
        transactions: rows.map((t) => ({
          date: t.tradeDate,
          type: t.type,
          instrument: t.instrumentId === null ? null : (byId.get(t.instrumentId) ?? null),
          quantity: formatQuantity(t.quantity),
          amountEur: formatMoney(t.amount),
          currency: t.currency,
        })),
      };
    },
  },
  {
    name: "get_spending",
    description:
      "Where money went from bank accounts in a period. groupBy: category (e.g. groceries, " +
      "restaurants, transport) or counterparty (by payee). Sums are already " +
      "calculated -- do not add them up yourself.",
    schema: Spending,
    run: async (input) => {
      const {
        from = "1900-01-01",
        to = today(),
        groupBy = "category",
        limit = 15,
      } = Spending.parse(input);
      // Bank rows minus movements: a share purchase, savings transfer or card bill would otherwise be the biggest "expense".
      const { txns, bankAccountIds } = await loadPortfolio(db, userId);
      const bank = new Set(bankAccountIds);
      const moved = notSpendingIds(txns, bank);
      const summary = summariseSpending(
        txns.filter((txn) => bank.has(txn.accountId) && !moved.has(txn.id)),
        { from, to, by: groupBy, limit, rules: await rulesFor(db, userId) },
      );
      return {
        from: summary.from,
        to: summary.to,
        totalEur: summary.totalEur,
        groups: summary.groups.map((group) => ({
          label: group.label,
          totalEur: group.totalEur,
          count: group.count,
        })),
        // Said out loud so an answer cannot imply every euro was classified.
        uncategorisedShare: summary.uncategorisedShare,
        note:
          "Sums are negative (money out). Categorisation is based on the payment text, " +
          "so some end up in the category Other. Mention uncategorisedShare if it is significant.",
      };
    },
  },

  {
    name: "get_uncategorised_spending",
    description:
      "Payments the rule-based categorisation did not recognise (category Other), by payee " +
      "and summed. Use this when you want to judge for yourself where they belong.",
    schema: Spending,
    run: async (input) => {
      const { from = "1900-01-01", to = today(), limit = 30 } = Spending.parse(input);
      const { txns, bankAccountIds } = await loadPortfolio(db, userId);
      const bank = new Set(bankAccountIds);
      const rules = await rulesFor(db, userId);
      const moved = notSpendingIds(txns, bank);
      const summary = summariseSpending(
        txns.filter(
          (txn) =>
            bank.has(txn.accountId) &&
            !moved.has(txn.id) &&
            categoriseWith(txn.note ?? "", rules) === "other",
        ),
        { from, to, by: "counterparty", limit, rules },
      );
      return {
        from,
        to,
        totalEur: summary.totalEur,
        merchants: summary.groups.map((group) => ({
          name: group.label,
          totalEur: group.totalEur,
          count: group.count,
        })),
        note:
          "These match no rule. You may judge the category from the name, " +
          "but say clearly that it is an estimate -- rule-based figures are certain, " +
          "yours is not.",
      };
    },
  },

  {
    name: "calculate",
    description:
      "Calculates exactly, to the cent: sum, subtract, multiply, divide, percent, average. " +
      "Always use this when deriving a figure from other figures -- do not calculate in your head.",
    schema: Calculation,
    run: (input) => {
      const { operation, values } = Calculation.parse(input);
      try {
        return Promise.resolve(calculate({ operation, values }));
      } catch (cause) {
        return Promise.resolve({
          error: cause instanceof Error ? cause.message : "Calculation failed",
        });
      }
    },
  },

  {
    name: "get_instruments",
    description: "Registered instruments: name, ISIN, kind, currency and price source.",
    schema: NoArgs,
    run: async (input) => {
      NoArgs.parse(input);
      const { txns, instruments } = await loadPortfolio(db, userId);
      // The registry is household-shared; narrow to what this user's ledger references so chat never names someone else's fund.
      const owned = new Set(txns.map((t) => t.instrumentId));
      return {
        instruments: instruments
          .filter((i) => owned.has(i.id))
          .map((i) => ({
            // The id a proposal names; the name alone could match two instruments.
            id: i.id,
            name: i.name,
            isin: i.isin,
            kind: i.kind,
            currency: i.currency,
            priceSource: i.priceSource,
          })),
      };
    },
  },
  {
    name: "get_drift",
    description:
      "Gap to the target allocation: each item's target, current share and difference in percent and euros, " +
      "and fees per year. by: kind (default), currency, account or instrument. " +
      "Do not suggest trades -- report the gap and what correcting it would take.",
    schema: Grouping,
    run: async (input) => {
      const { by = "kind" } = Grouping.parse(input);
      const on = today();
      const drift = await driftReportFor(db, userId, by, on);
      const fees = await feeReportFor(db, userId);
      return {
        asOf: on,
        groupBy: by,
        totalEur: drift.totalEur,
        // One unpriceable holding makes every slice's euro figure wrong by an unknown amount.
        incomplete: drift.incomplete,
        rows: drift.rows.map((row) => ({
          key: row.key,
          item: row.label,
          target: row.targetPercent,
          current: row.actualPercent,
          difference: row.driftPercent,
          movableEur: row.driftEur,
          withinBand: row.withinBand,
          untargeted: row.untargeted,
        })),
        fees: fees.map((year) => ({
          year: year.year,
          feesEur: year.totalEur,
          withheldTaxEur: year.withheldTaxEur,
        })),
        note:
          "No difference is calculated for untargeted items. Withheld capital income tax is not a fee " +
          "but tax on a gain. You give no investment advice and do not urge selling.",
      };
    },
  },
  {
    name: "get_tax_year",
    description:
      "Tax-year figures: disposal gains and losses, dividends and share savings account withdrawals. " +
      "These are for checking the tax return -- the amount of tax is not calculated, because " +
      "the capital-income tax rate also depends on income the app cannot see. Without a " +
      "year, the latest year with taxable events is returned.",
    schema: TaxYear,
    run: async (input) => {
      const { year } = TaxYear.parse(input);
      const years = await taxYearsFor(db, userId);
      // An empty ledger still answers for the current year; `availableYears` says which have data.
      const chosen = year ?? years[0] ?? Number(today().slice(0, 4));

      const report = await taxYearFor(db, userId, chosen);
      return {
        year: report.year,
        availableYears: years,
        exempt: report.exempt,
        totalSalePriceEur: report.totalSalePriceEur,
        gainsEur: report.gainsEur,
        lossesEur: report.lossesEur,
        taxableGainEur: report.netEur,
        lossCarriedOut: report.lossCarriedOut,
        dividendTaxableEur: report.dividendTaxableEur,
        // Said out loud so a net figure is not presented as gross.
        dividendWithholdingMissing: report.dividends.some((row) => !row.withholdingRecorded),
        ost: report.ost.map((account) => ({
          account: account.accountName,
          depositedEur: account.depositedEur,
          capRemainingEur: account.capRemainingEur,
          withdrawals: account.withdrawals.map((row) => ({
            date: row.withdrawnOn,
            amountEur: row.amountEur,
            taxableEur: row.taxableEur,
            blocked: row.blockedBy,
          })),
        })),
        note:
          "The amount of tax is not calculated. If a share savings account withdrawal is blocked, its " +
          "taxable part could not be calculated -- give the reason and do not guess a figure.",
      };
    },
  },
  ...buildMoneyTools(db, userId),
  ...buildRuleTools(db, userId),
];

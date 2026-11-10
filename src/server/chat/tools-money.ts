import { z } from "zod";

import { cashBalancesAt, totalCashEur, valueCash } from "../../core/cash.ts";
import { addMoney, EUR, formatMoney, parseMoney } from "../../core/money.ts";
import { valueSeries } from "../../core/returns.ts";
import { maskAccountNumbers } from "./mask.ts";
import { cashFlowFor } from "../spending/cashflow.ts";
import { CATEGORY_LABELS, labelForCategory } from "../spending/categories.ts";
import { cashlessAccountIds } from "../spending/internal.ts";
import { monthlyByCategory, monthlyFlows } from "../spending/monthly.ts";
import { rulesFor } from "../spending/rules.ts";
import { notSpendingIds } from "../spending/internal.ts";
import { recurringPayments } from "../spending/recurring.ts";
import { classifiedTransactions } from "../spending/transactions.ts";
import { depositPlanFor } from "../rebalance.ts";
import { reconciliationFor } from "../snapshots.ts";
import { holdingsFor, loadPortfolio } from "../valuation.ts";
import { yearlyCostSummary } from "../../core/fund-costs.ts";
import {
  type ChatTool,
  type Db,
  DEFAULT_TXN_LIMIT,
  IsoDateSchema,
  MAX_SERIES_POINTS,
  today,
  type ToolResult,
} from "./tool-types.ts";

const LEDGER_START = "1900-01-01";

const CATEGORY_KEYS = Object.keys(CATEGORY_LABELS);

const CashFlow = z
  .object({ from: IsoDateSchema.optional(), to: IsoDateSchema.optional() })
  .strict();

const Trend = z
  .object({
    from: IsoDateSchema.optional(),
    to: IsoDateSchema.optional(),
    // Named, not free text: an invented category would report zero, reading as "you spent nothing".
    // SAFETY: `z.enum` needs a non-empty tuple and `CATEGORY_LABELS` has an entry per category.
    category: z.enum(CATEGORY_KEYS as [string, ...string[]]).optional(),
  })
  .strict();

const Deposit = z
  .object({
    amountEur: z
      .string()
      .regex(/^\d+([.,]\d{1,2})?$/, 'The amount must be given in euros, for example "1500.00"')
      .refine((text) => parseMoney(text, EUR).minor > 0n, "The amount must be greater than zero"),
    on: IsoDateSchema.optional(),
    by: z.enum(["kind", "currency", "account", "instrument"]).optional(),
  })
  .strict();

const NoArgs = z.object({}).strict();

const RuleQuery = z
  .object({
    search: z.string().min(1).max(100).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();

const NetWorth = z
  .object({ from: IsoDateSchema.optional(), to: IsoDateSchema.optional() })
  .strict();

const Recurring = z
  .object({ from: IsoDateSchema.optional(), to: IsoDateSchema.optional() })
  .strict();

const Classified = z
  .object({
    from: IsoDateSchema.optional(),
    to: IsoDateSchema.optional(),
    search: z.string().min(1).max(100).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();

// Where money went and where it should go next. Split from `tools.ts` to keep both readable; same read-only contract.
export const buildMoneyTools = (db: Db, userId: string): ChatTool[] => [
  {
    name: "get_fund_costs",
    description:
      "What the funds and ETFs cost per year: each holding's ongoing charge (percent per year) " +
      "and its yearly cost in euros, plus the total. Answers 'what do my funds cost me'. " +
      "An unknown charge is null and adds nothing to the total -- do not guess one.",
    schema: NoArgs,
    run: async () => {
      const rows = (await holdingsFor(db, userId, today())).filter(
        (row) => row.kind === "fund" || row.kind === "etf",
      );
      const summary = yearlyCostSummary(rows);
      return {
        asOf: today(),
        // Null when no fee is known: zero would read as "free".
        totalYearlyCostEur: summary.totalEur,
        unknownCount: summary.total - summary.known,
        holdings: rows.map((row) => ({
          name: row.name,
          isin: row.isin,
          ongoingChargePercent:
            row.ongoingChargeBp === null ? null : (row.ongoingChargeBp / 100).toFixed(2),
          yearlyCostEur: row.yearlyCostEur,
          source: row.chargeSource?.source ?? null,
          sourceUrl: row.chargeSource?.url ?? null,
        })),
        note: "The total counts only holdings with a known charge (unknownCount have none). Sums are already calculated.",
      };
    },
  },

  {
    name: "get_cash_flow",
    description:
      "Cash flow of a period: how much came in, how much went out, how much was invested and " +
      "what was left. Answers 'did I spend more than I earned in June'. Sums are already " +
      "calculated -- do not add them up yourself.",
    schema: CashFlow,
    run: async (input) => {
      const { from = LEDGER_START, to = today() } = CashFlow.parse(input);
      const { txns, bankAccountIds } = await loadPortfolio(db, userId);
      const bank = new Set(bankAccountIds);
      // Non-bank accounts hold investments; their own deposits are the reliable record of money moved in (as /api/spending/cashflow).
      const invested = new Set(
        txns.map((txn) => txn.accountId).filter((accountId) => !bank.has(accountId)),
      );
      const flow = cashFlowFor({
        txns,
        rules: await rulesFor(db, userId),
        bankAccountIds: bank,
        investedAccountIds: invested,
        cashlessInvestedAccountIds: cashlessAccountIds(txns, bank),
        from,
        to,
      });

      const totalOf = (id: string): string =>
        flow.nodes.find((node) => node.id === id)?.totalEur ?? "0.00";
      // A shortfall is drawn as a flow into income; the figure stays positive, since a negative "left over" reads as idle money.
      const shortfall = flow.links.some((link) => link.from === "leftover");

      return {
        from: flow.from,
        to: flow.to,
        incomeEur: totalOf("income"),
        spendingEur: totalOf("expenses"),
        taxesEur: totalOf("taxes"),
        investedEur: totalOf("invested"),
        leftoverEur: totalOf("leftover"),
        spentMoreThanEarned: shortfall,
        byCategory: flow.nodes
          .filter((node) => node.id.startsWith("out:"))
          .map((node) => ({ label: maskAccountNumbers(node.label), totalEur: node.totalEur })),
        note:
          "Transfers between own accounts, payments into investments and paying a credit card " +
          "bill are neither spending nor income, so they are left out. " +
          (shortfall ? "The period ran a shortfall: the difference was covered from savings." : ""),
      };
    },
  },

  {
    name: "get_spending_trend",
    description:
      "Spending month by month: income, expenses and net per month, or the trend of one " +
      "category when category is given. Use this when asked whether something has grown or " +
      "fallen -- do not call get_spending once per month.",
    schema: Trend,
    run: async (input): Promise<ToolResult> => {
      const { from = LEDGER_START, to = today(), category } = Trend.parse(input);
      const { txns, bankAccountIds } = await loadPortfolio(db, userId);
      const shared = {
        txns,
        rules: await rulesFor(db, userId),
        bankAccountIds: new Set(bankAccountIds),
        from,
        to,
      };

      if (category !== undefined) {
        const byCategory = monthlyByCategory({ ...shared, labelFor: labelForCategory });
        const months = byCategory.months.slice(-MAX_SERIES_POINTS);
        return {
          from,
          to,
          category,
          label: labelForCategory(category),
          months: months.map((month) => ({
            month: month.month,
            totalEur: month.byCategory[category] ?? "0.00",
          })),
          truncated: byCategory.months.length > months.length,
          note: "Sums are positive numbers for what was spent.",
        };
      }

      const all = monthlyFlows(shared);
      const months = all.slice(-MAX_SERIES_POINTS);
      return {
        from,
        to,
        months: months.map((month) => ({
          month: month.month,
          incomeEur: month.incomeEur,
          expensesEur: month.expensesEur,
          netEur: month.netEur,
        })),
        truncated: all.length > months.length,
        note:
          "expensesEur is a positive number for what was spent. netEur is income minus expenses: " +
          "a negative netEur means the month ran a shortfall.",
      };
    },
  },

  {
    name: "get_deposit_plan",
    description:
      "Where new money should go so the allocation approaches the target. Give the amount " +
      "in euros. Only suggests purchases, never sales.",
    schema: Deposit,
    run: async (input) => {
      const { amountEur, on = today(), by = "kind" } = Deposit.parse(input);
      const deposit = parseMoney(amountEur, EUR);
      const allocations = await depositPlanFor(db, userId, by, on, deposit);

      return {
        asOf: on,
        groupBy: by,
        depositEur: formatMoney(deposit),
        allocations: allocations.map((allocation) => ({
          label: maskAccountNumbers(allocation.label),
          amountEur: allocation.amountEur,
        })),
        note:
          allocations.length === 0
            ? "No target is set for this dimension, so the split cannot be calculated. " +
              "A target can be set on the Rebalance page."
            : "Shares are measured against a target calculated from the total value after " +
              "the deposit. This realises no gain and causes no tax.",
      };
    },
  },

  {
    name: "get_transaction_class",
    description:
      "Individual bank transactions and the category they got: which category, whether it was " +
      "counted as spending, and if not why (own transfer, investment, income, opening balance). Use this " +
      "when asked why something does not show in spending. search narrows by the transaction's own text.",
    schema: Classified,
    run: async (input) => {
      const {
        from = LEDGER_START,
        to = today(),
        search,
        limit = DEFAULT_TXN_LIMIT,
      } = Classified.parse(input);
      const { txns, bankAccountIds } = await loadPortfolio(db, userId);
      const bank = new Set(bankAccountIds);
      const all = classifiedTransactions({
        txns,
        rules: await rulesFor(db, userId),
        bankAccountIds: bank,
        cashlessAccountIds: cashlessAccountIds(txns, bank),
        labelFor: labelForCategory,
        from,
        to,
      });

      const needle = search?.toLowerCase();
      const matching =
        needle === undefined ? all : all.filter((txn) => txn.text.toLowerCase().includes(needle));
      const shown = matching.slice(0, limit);

      return {
        from,
        to,
        count: matching.length,
        transactions: shown.map((txn) => ({
          date: txn.date,
          text: txn.text,
          amountEur: txn.amountEur,
          category: txn.category,
          categoryLabel: txn.categoryLabel,
          counted: txn.counted,
          excludedReason: txn.excludedReason,
        })),
        truncated: matching.length > shown.length,
        note:
          "counted=false means the row is not in the spending figures, and excludedReason " +
          "says why. The category is based on the transaction text, so an unknown payer is Other.",
      };
    },
  },

  {
    name: "get_spending_rules",
    description:
      "The user's categorisation rules: search term (pattern), category and who made the rule (seed = " +
      "the app's own, ai = you, user = the user). Look here before saving a new rule " +
      "or fixing an old one -- you see what already exists and what you may not change.",
    schema: RuleQuery,
    run: async (input): Promise<ToolResult> => {
      const { search, limit = 60 } = RuleQuery.parse(input);
      const all = await rulesFor(db, userId);
      const needle = search?.toUpperCase();
      const matching =
        needle === undefined
          ? all
          : all.filter(
              (rule) =>
                rule.pattern.includes(needle) || rule.category.toUpperCase().includes(needle),
            );
      const shown = [...matching]
        .sort((a, b) => a.pattern.localeCompare(b.pattern))
        .slice(0, limit);

      return {
        count: matching.length,
        bySource: {
          seed: all.filter((rule) => rule.source === "seed").length,
          ai: all.filter((rule) => rule.source === "ai").length,
          user: all.filter((rule) => rule.source === "user").length,
        },
        rules: shown.map((rule) => ({
          pattern: rule.pattern,
          category: rule.category,
          label: labelForCategory(rule.category),
          source: rule.source,
        })),
        truncated: matching.length > shown.length,
        note: "You cannot change or delete rules whose source is 'user'.",
      };
    },
  },

  {
    name: "get_reconciliation",
    description:
      "Reconcile: what the broker's own holdings report says compared with what is calculated " +
      "from transactions. Answers whether the figures are correct. An account with no report is " +
      "unchecked, not fine.",
    schema: NoArgs,
    run: async (input): Promise<ToolResult> => {
      NoArgs.parse(input);
      const checks = await reconciliationFor(db, userId);

      return {
        accounts: checks.map((check) => ({
          account: maskAccountNumbers(check.account),
          checkedAgainst: check.asOf,
          source: check.source,
          differences: check.differences,
          rows: check.rows.map((row) => ({
            name: row.name,
            derived: row.derived,
            statement: row.snapshot,
            delta: row.delta,
          })),
        })),
        unchecked: checks
          .filter((check) => check.asOf === null)
          .map((check) => maskAccountNumbers(check.account)),
        note:
          "checkedAgainst = null means no holdings report has been imported for the account, " +
          "so it was compared against nothing -- do not say it matches. A bank account's balance " +
          "is reconciled on the Cash page, not here.",
      };
    },
  },

  {
    name: "get_recurring_payments",
    description:
      "Recurring payments: subscriptions, rent, insurance, loan repayments. The same payee at least " +
      "three times, at regular intervals and for nearly the same amount. annualEur is what the payment " +
      "costs per year. active=false means the payment has ended.",
    schema: Recurring,
    run: async (input): Promise<ToolResult> => {
      const { from = LEDGER_START, to = today() } = Recurring.parse(input);
      const { txns, bankAccountIds } = await loadPortfolio(db, userId);
      const bank = new Set(bankAccountIds);
      const payments = recurringPayments({
        txns,
        rules: await rulesFor(db, userId),
        bankAccountIds: bank,
        excludedIds: notSpendingIds(txns, bank),
        from,
        to,
      });

      return {
        from,
        to,
        payments: payments.map((payment) => ({
          payee: payment.payee,
          categoryLabel: payment.categoryLabel,
          cadence: payment.cadence,
          typicalEur: payment.typicalEur,
          annualEur: payment.annualEur,
          count: payment.count,
          firstDate: payment.firstDate,
          lastDate: payment.lastDate,
          active: payment.active,
        })),
        note:
          "Sums are positive numbers for what is paid. The list is inferred from " +
          "transactions, not contracts: a payment of varying amount (e.g. a grocery shop) is " +
          "not included, nor is a payment made fewer than three times.",
      };
    },
  },

  {
    name: "get_net_worth_series",
    description:
      "Development of total wealth: investment value and bank account balances combined. " +
      "get_value_series shows investments only. At most 60 evenly spaced points.",
    schema: NetWorth,
    run: async (input): Promise<ToolResult> => {
      const { from = "2015-01-01", to = today() } = NetWorth.parse(input);
      const { investedTxns, cashTxns, instruments, prices } = await loadPortfolio(db, userId);
      const series = valueSeries(investedTxns, instruments, prices, from, to);
      // Thinned before valuing: each point walks every cash transaction.
      const step = Math.max(1, Math.ceil(series.length / MAX_SERIES_POINTS));

      return {
        from,
        to,
        points: series
          .filter((_, index) => index % step === 0 || index === series.length - 1)
          .map((point) => {
            const cash = totalCashEur(
              valueCash(cashBalancesAt(cashTxns, point.date), prices.fxOn, point.date),
            );
            return {
              date: point.date,
              positionsEur: formatMoney(point.valueEur),
              cashEur: formatMoney(cash),
              totalEur: formatMoney(addMoney(point.valueEur, cash)),
            };
          }),
        note:
          "Cash includes fixed-term deposits. Accounts whose data has no cash " +
          "transactions are not included at all -- their balance cannot be derived.",
      };
    },
  },
];

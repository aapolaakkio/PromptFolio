import { and, count, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import {
  EUR,
  formatMoney,
  money as moneyOf,
  parseCurrency,
  parseMoney,
  subMoney,
} from "../../core/money.ts";
import {
  CashEntryRemove,
  ConversationId,
  PlanRemoveInput,
  SnapshotQuery,
  SpendingRuleRemove,
  UndoInput,
} from "../action-inputs.ts";
import {
  accounts,
  chatMessages,
  conversations,
  imports,
  instrumentCosts,
  snapshotRows,
  transactions,
} from "../db/schema.ts";
import { ForecastRateRemoveInput } from "../forecast-inputs.ts";
import { listPlan } from "../monthly-plan.ts";
import { labelForCategory } from "../spending/categories.ts";
import { rulesFor } from "../spending/rules.ts";
import { loadPortfolio } from "../valuation.ts";
import {
  REMOVAL_RULES,
  accountName,
  maskAccountNumbers,
  instrumentLabel,
  money,
  newId,
  ownInstrument,
  ownSnapshot,
  text,
} from "./proposal-kit.ts";
import type { Proposal } from "./proposal-schema.ts";
import { forecastInstrument, storedRate } from "./proposals-instruments.ts";
import type { Db, ProposalArea, ProposalTool, ToolArgs } from "./tool-types.ts";

const REMOVALS: ProposalArea = {
  name: "Removals",
  sentence:
    "delete one cash entry typed by hand, one monthly plan row or one spending rule, remove one " +
    "holdings statement, undo one import, remove one other conversation, or clear one fund's fee " +
    "or one forecast rate (one thing per card)",
};

const HAND_TYPED = {
  DEPOSIT: "Deposit (money in)",
  WITHDRAWAL: "Withdrawal (money out)",
  INTEREST: "Interest (money in)",
  OPENING_BALANCE: "Opening balance",
} as const;

const isHandTyped = (type: string): type is keyof typeof HAND_TYPED =>
  Object.hasOwn(HAND_TYPED, type);

const dayOf = (date: Date): string => date.toISOString().slice(0, 10);

/** The parts every removal card shares: a fresh id and the warning flag. */
const removal = (title: string, facts: Proposal["facts"], summary: string) => ({
  proposalId: newId(),
  danger: true as const,
  title,
  facts,
  summary,
});

const proposeCashEntry = async (db: Db, userId: string, raw: ToolArgs): Promise<Proposal> => {
  const input = CashEntryRemove.parse(raw);
  const row = await db
    .select({ entry: transactions, account: accounts })
    .from(transactions)
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .where(and(eq(transactions.id, input.id), eq(accounts.userId, userId)))
    .get();
  if (row === undefined) throw new Error("Cash entry not found");
  const { entry, account } = row;
  if (entry.importId !== null || !isHandTyped(entry.type)) {
    throw new Error(
      "Only a cash entry typed by hand can be deleted here; an import is undone whole",
    );
  }
  const currency = parseCurrency(entry.currency);
  const amount = formatMoney(moneyOf(BigInt(Math.abs(entry.amount)), currency));
  const direction = HAND_TYPED[entry.type];
  return {
    ...removal(
      "Delete a cash entry",
      [
        text("Cash entry", `${direction}, entry #${entry.id}`),
        money("Amount", amount, currency),
        text("Date", entry.tradeDate),
        text("Account", accountName(account)),
      ],
      `Delete the cash entry #${entry.id}: ${direction} of ${amount} ${currency} on ${entry.tradeDate}, ${accountName(account)}.`,
    ),
    action: "delete_cash_entry",
    input,
  };
};

const proposePlanRow = async (db: Db, userId: string, raw: ToolArgs): Promise<Proposal> => {
  const input = PlanRemoveInput.parse(raw);
  const plan = await listPlan(db, userId);
  const row = plan.rows.find((candidate) => candidate.instrumentId === input.instrumentId);
  if (row === undefined)
    throw new Error("That instrument is not in the monthly plan. Check get_monthly_plan");
  const after = formatMoney(
    subMoney(parseMoney(plan.totalEur, EUR), parseMoney(row.amountEur, EUR)),
  );
  const name = instrumentLabel(row);
  return {
    ...removal(
      "Delete a monthly plan row",
      [
        text("Plan row", name),
        money("Monthly amount", formatMoney(parseMoney(row.amountEur, EUR)), EUR),
        money("Plan total afterwards", after, EUR),
      ],
      `Delete ${name} (${row.amountEur} EUR a month) from the monthly plan; it then totals ${after} EUR.`,
    ),
    action: "delete_plan_row",
    input,
  };
};

const MADE_BY = {
  user: "You",
  ai: "Saved automatically at import",
  seed: "Built into the app",
} as const;

const proposeRule = async (db: Db, userId: string, raw: ToolArgs): Promise<Proposal> => {
  const input = SpendingRuleRemove.parse(raw);
  const pattern = input.pattern.trim().toUpperCase();
  const rule = (await rulesFor(db, userId)).find((stored) => stored.pattern === pattern);
  if (rule === undefined) throw new Error("No such rule. Check get_spending_rules");
  const { txns, bankAccountIds } = await loadPortfolio(db, userId);
  const bank = new Set(bankAccountIds);
  const matches = txns.filter(
    (txn) => bank.has(txn.accountId) && (txn.note ?? "").toUpperCase().includes(pattern),
  ).length;
  const category = labelForCategory(rule.category);
  return {
    ...removal(
      "Delete a spending rule",
      [
        { kind: "code", label: "Rule", code: pattern },
        text("Category", category),
        text("Made by", MADE_BY[rule.source]),
        text("Payments it matches", String(matches)),
      ],
      `Delete the spending rule ${pattern} (${category}); its ${matches} payments are categorised again without it.`,
    ),
    action: "delete_spending_rule",
    input: { pattern },
  };
};

const SOURCE = {
  manual: "Typed by hand",
  pdf: "Read from a PDF",
  vision: "Read from an image",
} as const;

const proposeSnapshot = async (db: Db, userId: string, raw: ToolArgs): Promise<Proposal> => {
  const input = SnapshotQuery.parse(raw);
  const { snapshot, account } = await ownSnapshot(db, userId, input.snapshotId);
  const rows = await db
    .select({ rows: count() })
    .from(snapshotRows)
    .where(eq(snapshotRows.snapshotId, snapshot.id))
    .get();
  const statement = `${accountName(account)}, as of ${snapshot.asOf} (#${snapshot.id})`;
  return {
    ...removal(
      "Remove a holdings statement",
      [
        text("Holdings statement", statement),
        text("Source", SOURCE[snapshot.source]),
        text("Rows removed", String(rows?.rows ?? 0)),
        text("Kept", "Adjustments booked from it stay in the ledger"),
      ],
      `Remove the holdings statement of ${statement}.`,
    ),
    action: "remove_snapshot",
    input: { snapshotId: snapshot.id },
  };
};

const proposeUndo = async (db: Db, userId: string, raw: ToolArgs): Promise<Proposal> => {
  const input = UndoInput.parse(raw);
  const record = await db
    .select()
    .from(imports)
    .where(and(eq(imports.id, input.importId), eq(imports.userId, userId)))
    .get();
  if (record === undefined) throw new Error("Import not found");
  if (record.status === "undone") throw new Error("That import is already undone");
  const rows = await db
    .select({ accountId: transactions.accountId })
    .from(transactions)
    .where(eq(transactions.importId, record.id))
    .all();
  const accountIds = [...new Set(rows.map((row) => row.accountId))];
  const owned =
    accountIds.length === 0
      ? []
      : await db
          .select()
          .from(accounts)
          .where(and(inArray(accounts.id, accountIds), eq(accounts.userId, userId)))
          .all();
  const file = `${maskAccountNumbers(record.filename)} (#${record.id})`;
  return {
    ...removal(
      "Undo an import",
      [
        text("Import", file),
        text("Imported on", dayOf(record.createdAt)),
        text("Account", owned.map(accountName).join("; ") || "None"),
        text("Transactions removed", String(rows.length)),
      ],
      `Undo the import ${file} of ${dayOf(record.createdAt)}: ${rows.length} transactions will be removed.`,
    ),
    action: "undo_import",
    input: { importId: record.id },
  };
};

const proposeConversation = async (
  db: Db,
  userId: string,
  current: number | undefined,
  raw: ToolArgs,
): Promise<Proposal> => {
  const input = ConversationId.parse(raw);
  if (input.id === current) {
    throw new Error(
      "This is the conversation you are in; the owner removes it from the conversation list",
    );
  }
  const row = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, input.id), eq(conversations.userId, userId)))
    .get();
  if (row === undefined) throw new Error("Conversation not found");
  const messages = await db
    .select({ messages: count() })
    .from(chatMessages)
    .where(eq(chatMessages.conversationId, row.id))
    .get();
  const name = `${row.title ?? "Conversation"} (#${row.id})`;
  return {
    ...removal(
      "Remove a conversation",
      [
        text("Conversation", name),
        text("Started", dayOf(row.createdAt)),
        text("Messages removed", String(messages?.messages ?? 0)),
      ],
      `Remove the conversation ${name} of ${dayOf(row.createdAt)}.`,
    ),
    action: "remove_conversation",
    input: { id: row.id },
  };
};

const FundRef = z.object({ id: z.number().int().positive() }).strict();

const proposeClearFee = async (db: Db, userId: string, raw: ToolArgs): Promise<Proposal> => {
  const input = FundRef.parse(raw);
  const fund = await ownInstrument(db, userId, input.id);
  const cost = await db
    .select()
    .from(instrumentCosts)
    .where(eq(instrumentCosts.instrumentId, fund.id))
    .get();
  const bp = cost?.ongoingChargeBp ?? null;
  if (bp === null) throw new Error("No fee is recorded for that fund");
  const fee = `${(bp / 100).toFixed(2)} % a year (${cost?.source === "user" ? "yours" : "looked up"})`;
  const name = instrumentLabel(fund);
  return {
    ...removal(
      "Clear a fund's fee",
      [
        text("Fund", name),
        text("Fee cleared", fee),
        text("Afterwards", "A fee lookup may fill it in again"),
      ],
      `Clear the fee of ${name}: ${fee}.`,
    ),
    action: "clear_fund_fee",
    input: { id: fund.id, percent: "" },
  };
};

const proposeClearRate = async (db: Db, userId: string, raw: ToolArgs): Promise<Proposal> => {
  const input = ForecastRateRemoveInput.parse(raw);
  const instrument = await forecastInstrument(db, userId, input.instrumentId);
  const rate = await storedRate(db, userId, instrument.id);
  if (rate === null) throw new Error("No rate of the owner's is set for that instrument");
  const name = instrumentLabel(instrument);
  return {
    ...removal(
      "Clear a forecast rate",
      [
        text("Instrument", name),
        text("Rate cleared", rate),
        text("Afterwards", "Forecasts use the rate measured from past prices"),
      ],
      `Clear the forecast rate of ${name} (${rate}); forecasts then use the measured rate.`,
    ),
    action: "clear_forecast_rate",
    input: { instrumentId: instrument.id },
  };
};

/** One removal per card, each resolved by the app from its id; there is no tool that removes "all" of anything. */
export const buildDeletionProposals = (
  db: Db,
  userId: string,
  conversationId?: number,
): ProposalTool[] => [
  {
    area: REMOVALS,
    name: "propose_delete_cash_entry",
    description:
      "Proposes deleting one cash entry typed by hand (id from get_cash_entries). An imported row " +
      "cannot be deleted; its import is undone whole." +
      REMOVAL_RULES,
    schema: CashEntryRemove,
    propose: (input) => proposeCashEntry(db, userId, input),
  },
  {
    area: REMOVALS,
    name: "propose_delete_plan_row",
    description:
      "Proposes deleting one row of the monthly plan (instrumentId from get_monthly_plan)." +
      REMOVAL_RULES,
    schema: PlanRemoveInput,
    propose: (input) => proposePlanRow(db, userId, input),
  },
  {
    area: REMOVALS,
    name: "propose_delete_spending_rule",
    description:
      "Proposes deleting one spending rule (pattern from get_spending_rules); its payments are " +
      "categorised again without it." +
      REMOVAL_RULES,
    schema: SpendingRuleRemove,
    propose: (input) => proposeRule(db, userId, input),
  },
  {
    area: REMOVALS,
    name: "propose_remove_snapshot",
    description:
      "Proposes removing one holdings statement (snapshotId from get_snapshots)." + REMOVAL_RULES,
    schema: SnapshotQuery,
    propose: (input) => proposeSnapshot(db, userId, input),
  },
  {
    area: REMOVALS,
    name: "propose_undo_import",
    description:
      "Proposes undoing one import (importId from get_imports): every transaction it brought in " +
      "is removed." +
      REMOVAL_RULES,
    schema: UndoInput,
    propose: (input) => proposeUndo(db, userId, input),
  },
  {
    area: REMOVALS,
    name: "propose_remove_conversation",
    description:
      "Proposes removing one other chat conversation (id from get_conversations), never the one " +
      "you are in." +
      REMOVAL_RULES,
    schema: ConversationId,
    propose: (input) => proposeConversation(db, userId, conversationId, input),
  },
  {
    area: REMOVALS,
    name: "propose_clear_fund_fee",
    description:
      "Proposes clearing the recorded fee of one fund (id from get_instruments)." + REMOVAL_RULES,
    schema: FundRef,
    propose: (input) => proposeClearFee(db, userId, input),
  },
  {
    area: REMOVALS,
    name: "propose_clear_forecast_rate",
    description:
      "Proposes clearing the owner's own forecast rate of one instrument (instrumentId from " +
      "get_instruments), so forecasts use the measured rate again." +
      REMOVAL_RULES,
    schema: ForecastRateRemoveInput,
    propose: (input) => proposeClearRate(db, userId, input),
  },
];

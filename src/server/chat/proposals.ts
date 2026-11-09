import type { Dimension } from "../../core/allocation.ts";
import {
  EUR,
  addMoney,
  formatMoney,
  parseCurrency,
  parseMoney,
  zeroMoney,
} from "../../core/money.ts";
import { checkTargets } from "../../core/rebalance/targets.ts";
import { listAccounts } from "../accounts.ts";
import {
  CashEntry,
  PlanInput,
  PriceInput,
  TargetAllocationInput,
  toBasisPoints,
} from "../action-inputs.ts";
import { listInstruments } from "../instruments/store.ts";
import { listPlan, planFingerprint } from "../monthly-plan.ts";
import { driftReportFor } from "../rebalance.ts";
import {
  AWAITS,
  canonical,
  instrumentLabel,
  newId,
  ownAccountLabel,
  ownInstrument,
  text,
} from "./proposal-kit.ts";
import type { Fact, Proposal } from "./proposal-schema.ts";
import { buildAccountProposals } from "./proposals-accounts.ts";
import { buildDeletionProposals } from "./proposals-deletions.ts";
import { buildInstrumentProposals } from "./proposals-instruments.ts";
import { buildRuleProposals } from "./proposals-rules.ts";
import { buildSnapshotProposals } from "./proposals-snapshots.ts";
import {
  type Db,
  type ProposalArea,
  type ProposalTool,
  type ToolArgs,
  today,
} from "./tool-types.ts";

const CASH = {
  DEPOSIT: {
    title: "Record a deposit",
    direction: "Deposit (money in)",
    word: "a deposit",
    to: "to",
  },
  WITHDRAWAL: {
    title: "Record a withdrawal",
    direction: "Withdrawal (money out)",
    word: "a withdrawal",
    to: "from",
  },
  INTEREST: {
    title: "Record interest",
    direction: "Interest (money in)",
    word: "interest",
    to: "on",
  },
  OPENING_BALANCE: {
    title: "Record an opening balance",
    direction: "Opening balance",
    word: "an opening balance",
    to: "on",
  },
} as const;

const proposeRecordPrice = async (db: Db, userId: string, raw: ToolArgs): Promise<Proposal> => {
  const input = PriceInput.parse(raw);
  const instrument = await ownInstrument(db, userId, input.instrumentId);
  const currency = parseCurrency(instrument.currency);
  const price = canonical(input.price, currency);
  if (parseMoney(input.price, currency).minor <= 0n) throw new Error("The price must be positive");
  const name = instrumentLabel(instrument);
  return {
    proposalId: newId(),
    action: "record_price",
    title: "Record a manual price",
    facts: [
      text("Instrument", name),
      { kind: "money", label: "Price", amount: price, currency },
      text("Date", input.date),
    ],
    summary: `Record a manual price of ${price} ${currency} for ${name} on ${input.date}.`,
    input,
  };
};

// The note is the model's own text: it travels only in `input`, which the card shows apart, labelled.
const proposeCashEntry = async (db: Db, userId: string, raw: ToolArgs): Promise<Proposal> => {
  const input = CashEntry.parse(raw);
  const account = await ownAccountLabel(db, userId, input.accountId);
  const amount = canonical(input.amount, input.currency);
  const wording = CASH[input.type];
  return {
    proposalId: newId(),
    action: "cash_entry",
    title: wording.title,
    facts: [
      text("Account", account),
      text("Direction", wording.direction),
      { kind: "money", label: "Amount", amount, currency: input.currency },
      text("Date", input.tradeDate),
    ],
    summary: `Record ${wording.word} of ${amount} ${input.currency} ${wording.to} ${account} on ${input.tradeDate}.`,
    input,
  };
};

/** Slice labels the owner recognises; by account, the stored account name and id. */
const sliceLabels = async (
  db: Db,
  userId: string,
  dimension: Dimension,
): Promise<ReadonlyMap<string, string>> => {
  const { rows } = await driftReportFor(db, userId, dimension, today());
  const names = new Map(
    (await listAccounts(db, userId)).map((account) => [
      String(account.id),
      `${account.name} (account #${account.id})`,
    ]),
  );
  return new Map(
    rows.map((row) => [
      row.key,
      dimension === "account" ? (names.get(row.key) ?? row.label) : row.label,
    ]),
  );
};

const proposeTargets = async (db: Db, userId: string, raw: ToolArgs): Promise<Proposal> => {
  const input = TargetAllocationInput.parse(raw);
  const labels = await sliceLabels(db, userId, input.dimension);
  const unknown = input.targets.find((target) => !labels.has(target.key));
  if (unknown !== undefined) {
    const known = [...labels].map(([key, label]) => `${key} (${label})`).join(", ");
    throw new Error(`Unknown key: ${unknown.key}. Keys for ${input.dimension}: ${known || "none"}`);
  }
  const error = checkTargets(
    input.targets.map((target) => ({
      key: target.key,
      weightBp: toBasisPoints(target.weightPercent),
    })),
  );
  if (error !== null) throw new Error(error.message);
  const lines = input.targets.map((target) => ({
    label: labels.get(target.key) ?? target.key,
    percent: `${(toBasisPoints(target.weightPercent) / 100).toFixed(2)} %`,
  }));
  return {
    proposalId: newId(),
    action: "target_allocation",
    title: "Set the target allocation",
    facts: [
      text("Dimension", input.dimension),
      ...lines.map((line) => text(line.label, line.percent)),
    ],
    summary: `Set the target allocation by ${input.dimension} to: ${lines.map((line) => `${line.label} ${line.percent}`).join(", ")}.`,
    input,
  };
};

/** The registry is household-shared and a plan may start a new position, so any known id is allowed; its name comes from the registry, never from the model. */
const proposePlan = async (db: Db, userId: string, raw: ToolArgs): Promise<Proposal> => {
  const input = PlanInput.parse(raw);
  const registry = new Map((await listInstruments(db)).map((item) => [item.id, item]));
  const rows = input.rows.map((row) => {
    const instrument = registry.get(row.instrumentId);
    if (instrument === undefined) {
      throw new Error(
        `Instrument not found: ${row.instrumentId}. Ask the owner which one is meant`,
      );
    }
    return {
      name: instrumentLabel(instrument),
      id: row.instrumentId,
      amount: canonical(row.amountEur, EUR),
    };
  });
  const current = (await listPlan(db, userId)).rows;
  const listed = new Set(rows.map((row) => row.id));
  const removed =
    input.mode === "replace" ? current.filter((row) => !listed.has(row.instrumentId)) : [];
  const kept = input.mode === "add" ? current.filter((row) => !listed.has(row.instrumentId)) : [];
  const total = formatMoney(
    [...rows.map((row) => row.amount), ...kept.map((row) => row.amountEur)]
      .map((amount) => parseMoney(amount, EUR))
      .reduce(addMoney, zeroMoney(EUR)),
  );
  const replacing = input.mode === "replace";
  const removedNames = removed.map((row) => instrumentLabel(row));
  const facts: Fact[] = [
    ...rows.map((row): Fact => ({
      kind: "money",
      label: row.name,
      amount: row.amount,
      currency: EUR,
    })),
    ...(removedNames.length === 0 ? [] : [text("Removed from the plan", removedNames.join("; "))]),
    { kind: "money", label: "Plan total per month", amount: total, currency: EUR },
  ];
  const lines = rows.map((row) => `${row.name} ${row.amount} ${EUR}`).join(", ");
  return {
    proposalId: newId(),
    action: "monthly_plan",
    title: replacing ? "Set the monthly plan" : "Add to the monthly plan",
    facts,
    summary:
      `${replacing ? "Set the monthly plan to" : "Add to the monthly plan"}: ${lines}.` +
      (removedNames.length === 0 ? "" : ` Removes: ${removedNames.join(", ")}.`) +
      ` The plan then totals ${total} ${EUR} per month.`,
    input: {
      rows: input.rows,
      removeInstrumentIds: removed.map((row) => row.instrumentId),
      fingerprint: await planFingerprint(db, userId),
    },
  };
};

const LEDGER: ProposalArea = {
  name: "Ledger and plan",
  sentence:
    "record a manual price, a cash entry (deposit, withdrawal, interest or opening balance), " +
    "the target allocation and the monthly plan",
};

const ledgerProposals = (db: Db, userId: string): ProposalTool[] => [
  {
    area: LEDGER,
    name: "propose_record_price",
    description:
      "Proposes recording a manual price for one instrument on one date. instrumentId comes " +
      "from get_instruments; price is a decimal string in the instrument's currency." +
      AWAITS,
    schema: PriceInput,
    propose: (input) => proposeRecordPrice(db, userId, input),
  },
  {
    area: LEDGER,
    name: "propose_cash_entry",
    description:
      "Proposes a manual cash entry on one account: DEPOSIT, WITHDRAWAL, INTEREST or " +
      "OPENING_BALANCE. accountId comes from get_accounts; amount is a positive decimal string, " +
      "the direction comes only from type." +
      AWAITS,
    schema: CashEntry,
    propose: (input) => proposeCashEntry(db, userId, input),
  },
  {
    area: LEDGER,
    name: "propose_target_allocation",
    description:
      "Proposes replacing the target allocation on one dimension. Each key comes from " +
      "get_drift for that dimension; the percentages must add up to exactly 100." +
      AWAITS,
    schema: TargetAllocationInput,
    propose: (input) => proposeTargets(db, userId, input),
  },
  {
    area: LEDGER,
    name: "propose_monthly_plan",
    description:
      "Proposes the owner's monthly investment plan from what the owner told you: rows of " +
      "{instrumentId, amountEur} (1 to 30, one per instrument, amountEur a positive decimal " +
      "string up to 1000000), and mode: replace (the plan becomes exactly these rows) or add " +
      "(these rows are set, the others kept). Find every instrumentId with get_instruments or " +
      "get_monthly_plan; never guess one. If a name is unknown or matches several instruments, " +
      "ask the owner instead of proposing." +
      AWAITS,
    schema: PlanInput,
    propose: (input) => proposePlan(db, userId, input),
  },
];

/**
 * Every owner action the assistant may propose, one area per file. Each validates with its form's own
 * schema, resolves ids against the caller's data and writes nothing; Confirm runs the form's own server
 * function. Not offered: file imports, sign-in and passwords, and deleting an account or the ledger.
 */
export const buildProposalTools = (
  db: Db,
  userId: string,
  conversationId?: number,
): ProposalTool[] => [
  ...ledgerProposals(db, userId),
  ...buildAccountProposals(db, userId),
  ...buildInstrumentProposals(db, userId),
  ...buildSnapshotProposals(db, userId),
  ...buildRuleProposals(db, userId),
  ...buildDeletionProposals(db, userId, conversationId),
];

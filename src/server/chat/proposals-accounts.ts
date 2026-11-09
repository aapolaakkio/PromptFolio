import { EUR, formatMoney, money as moneyOf } from "../../core/money.ts";
import { ACCOUNT_KINDS, accountTypeLabel } from "../../web/routes/account-type.ts";
import { assertTermsMatchType, assertTypeMatchesKind } from "../accounts.ts";
import { BalanceInput, CreateAccount, EditAccountInput } from "../action-inputs.ts";
import { HttpError } from "../errors.ts";
import { balancePlan } from "../import/bank-service.ts";
import {
  ASK_WHEN_UNSURE,
  AWAITS,
  accountName,
  money,
  newId,
  ownAccount,
  text,
} from "./proposal-kit.ts";
import type { Fact, Proposal } from "./proposal-schema.ts";
import type { Db, ProposalArea, ProposalTool, ToolArgs } from "./tool-types.ts";

const ACCOUNTS: ProposalArea = {
  name: "Accounts",
  sentence:
    "open an account, rename one or change its type, maturity date or interest rate, and " +
    "record an account's balance on a date",
};

const BROKER_LABEL = {
  nordnet: "Nordnet",
  op: "OP",
  spankki: "S-Pankki",
  danske: "Danske Bank",
  other: "Other",
} as const;

const kindLabel = (kind: string): string =>
  ACCOUNT_KINDS.find((candidate) => candidate.id === kind)?.label ?? kind;

const rateText = (rate: string | null): string =>
  rate === null ? "None" : `${Number(rate.replace(",", ".")).toFixed(2)} % a year`;

/** The form's own refusals, as plain errors the model reads. */
const checked = (check: () => void): void => {
  try {
    check();
  } catch (cause) {
    if (cause instanceof HttpError) throw new Error(cause.message);
    throw cause;
  }
};

const proposeCreate = (raw: ToolArgs): Proposal => {
  const input = CreateAccount.parse(raw);
  checked(() => assertTypeMatchesKind(input.kind, input.accountType));
  checked(() => assertTermsMatchType(input.accountType, input));
  const facts: Fact[] = [
    text("Name (as it will be saved)", input.name),
    text("Bank or broker", BROKER_LABEL[input.broker]),
    text("Kind", kindLabel(input.kind)),
    text("Type", accountTypeLabel(input.accountType ?? null)),
    text("Base currency", input.baseCurrency),
    ...((input.maturityDate ?? null) === null
      ? []
      : [text("Maturity date", input.maturityDate ?? "")]),
    ...((input.interestRate ?? null) === null
      ? []
      : [text("Interest rate", rateText(input.interestRate ?? null))]),
  ];
  return {
    proposalId: newId(),
    action: "create_account",
    title: "Open an account",
    facts,
    summary:
      `Open the ${kindLabel(input.kind).toLowerCase()} "${input.name}" at ` +
      `${BROKER_LABEL[input.broker]}, type ${accountTypeLabel(input.accountType ?? null)}, in ${input.baseCurrency}.`,
    input,
  };
};

const change = (label: string, was: string, now: string): Fact => text(label, `${was} → ${now}`);

const proposeEdit = async (db: Db, userId: string, raw: ToolArgs): Promise<Proposal> => {
  const input = EditAccountInput.parse(raw);
  const account = await ownAccount(db, userId, input.id);
  const { changes } = input;
  const type = changes.accountType === undefined ? account.accountType : changes.accountType;
  checked(() => assertTypeMatchesKind(account.kind, type));
  checked(() => assertTermsMatchType(type, changes));
  const storedRate =
    account.interestRateBp === null ? null : (account.interestRateBp / 100).toFixed(2);
  const facts: Fact[] = [
    text("Account", accountName(account)),
    ...(changes.name === undefined ? [] : [change("Name", account.name, changes.name)]),
    ...(changes.accountType === undefined
      ? []
      : [
          change(
            "Type",
            accountTypeLabel(account.accountType),
            accountTypeLabel(changes.accountType),
          ),
        ]),
    ...(changes.maturityDate === undefined
      ? []
      : [change("Maturity date", account.maturityDate ?? "None", changes.maturityDate ?? "None")]),
    ...(changes.interestRate === undefined
      ? []
      : [change("Interest rate", rateText(storedRate), rateText(changes.interestRate))]),
  ];
  const listed = facts
    .slice(1)
    .map((fact) => (fact.kind === "text" ? `${fact.label} ${fact.text}` : fact.label));
  return {
    proposalId: newId(),
    action: "edit_account",
    title: "Change an account",
    facts,
    summary: `Change ${accountName(account)}: ${listed.join("; ")}.`,
    input,
  };
};

const proposeBalance = async (db: Db, userId: string, raw: ToolArgs): Promise<Proposal> => {
  const input = BalanceInput.parse(raw);
  const account = await ownAccount(db, userId, input.accountId);
  const plan = await balancePlan(userId, input);
  const stated = formatMoney(plan.stated);
  const opening = formatMoney(plan.opening);
  const replaced =
    plan.existingOpening === undefined
      ? text("Replaces", "No opening balance recorded")
      : money(
          `Replaces the opening balance of ${plan.existingOpening.tradeDate}`,
          formatMoney(moneyOf(BigInt(plan.existingOpening.amount), EUR)),
          EUR,
        );
  return {
    proposalId: newId(),
    action: "account_balance",
    title: "Record an account balance",
    facts: [
      text("Account", accountName(account)),
      money(`Balance on ${input.on}`, stated, EUR),
      money("Opening balance written", opening, EUR),
      text("Opening balance date", plan.openingDate),
      replaced,
    ],
    summary:
      `Record a balance of ${stated} EUR on ${input.on} for ${accountName(account)}, by writing ` +
      `an opening balance of ${opening} EUR on ${plan.openingDate}.`,
    input: { ...input, expectOpeningEur: opening, expectOpeningDate: plan.openingDate },
  };
};

export const buildAccountProposals = (db: Db, userId: string): ProposalTool[] => [
  {
    area: ACCOUNTS,
    name: "propose_create_account",
    description:
      "Proposes opening an account: name, broker (nordnet, op, spankki, danske, other), kind " +
      "(brokerage or bank), accountType (brokerage: aot, ost, other; bank: current, savings, " +
      "fixed_term, credit), optional baseCurrency (EUR by default), and for a fixed-term " +
      'account its maturityDate and interestRate ("3.25"). Use the name the owner gave.' +
      AWAITS,
    schema: CreateAccount,
    propose: async (input) => proposeCreate(input),
  },
  {
    area: ACCOUNTS,
    name: "propose_edit_account",
    description:
      "Proposes changing one account (id from get_accounts): changes holds only what changes " +
      "-- name, accountType (of the account's own kind, or null), maturityDate, interestRate. " +
      "The kind, broker and currency cannot change." +
      ASK_WHEN_UNSURE +
      AWAITS,
    schema: EditAccountInput,
    propose: (input) => proposeEdit(db, userId, input),
  },
  {
    area: ACCOUNTS,
    name: "propose_account_balance",
    description:
      "Proposes recording what an account held on a date (accountId from get_accounts, on, " +
      "balance a signed decimal string). The app writes the opening balance that makes the " +
      "account's rows add up to it, replacing any earlier one." +
      ASK_WHEN_UNSURE +
      AWAITS,
    schema: BalanceInput,
    propose: (input) => proposeBalance(db, userId, input),
  },
];

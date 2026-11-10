import { SpendingRuleChange, SpendingRulesSave } from "../action-inputs.ts";
import { CATEGORY_LABELS, labelForCategory } from "../spending/categories.ts";
import { unknownMerchants } from "../spending/classify.ts";
import { categoriseWith, isCategory, rulesFor } from "../spending/rules.ts";
import { loadPortfolio } from "../valuation.ts";
import { AWAITS, RULE_MADE_BY, newId, text } from "./proposal-kit.ts";
import type { Fact, Proposal } from "./proposal-schema.ts";
import type { Db, ProposalArea, ProposalTool, ToolArgs } from "./tool-types.ts";

const RULES: ProposalArea = {
  name: "Spending rules",
  sentence: "save categorisation rules for payees and move a rule to another category",
};

const CATEGORIES = Object.keys(CATEGORY_LABELS).join(", ");

const knownCategory = (category: string): string => {
  if (!isCategory(category))
    throw new Error(`Unknown category: ${category}. Use one of ${CATEGORIES}`);
  return category;
};

/** Payee text is untrusted statement data, so a new rule must occur in a payee of this ledger that no rule matches yet. */
const proposeRules = async (db: Db, userId: string, raw: ToolArgs): Promise<Proposal> => {
  const input = SpendingRulesSave.parse(raw);
  const { txns, bankAccountIds } = await loadPortfolio(db, userId);
  const bank = new Set(bankAccountIds);
  const rules = await rulesFor(db, userId);
  const unknown = unknownMerchants(txns, rules, bank).map((name) => name.toUpperCase());
  const wanted = input.rules.map((rule) => ({
    pattern: rule.pattern.toUpperCase(),
    category: knownCategory(rule.category),
  }));
  const existing = wanted.filter((rule) => rules.some((stored) => stored.pattern === rule.pattern));
  if (existing.length > 0) {
    throw new Error(`${existing.map((rule) => rule.pattern).join(", ")} already has a rule`);
  }
  const invented = wanted.filter((rule) => !unknown.some((name) => name.includes(rule.pattern)));
  if (invented.length > 0) {
    throw new Error(
      `Not in any uncategorised payee of the ledger: ${invented.map((rule) => rule.pattern).join(", ")}`,
    );
  }
  const catches = (pattern: string): number =>
    txns.filter(
      (txn) =>
        bank.has(txn.accountId) &&
        (txn.note ?? "").toUpperCase().includes(pattern) &&
        categoriseWith(txn.note ?? "", rules) === "other",
    ).length;
  const facts: Fact[] = [
    ...wanted.flatMap((rule): Fact[] => [
      { kind: "code", label: "Payee text", code: rule.pattern },
      text("Category", labelForCategory(rule.category)),
      text("Catches", `${catches(rule.pattern)} uncategorised transactions`),
    ]),
    text("Saved as", "Your own rules, editable on the Spending page"),
  ];
  const listed = wanted.map((rule) => `${rule.pattern} as ${labelForCategory(rule.category)}`);
  return {
    proposalId: newId(),
    action: "spending_rules",
    title: wanted.length === 1 ? "Save a spending rule" : `Save ${wanted.length} spending rules`,
    facts,
    summary: `Save spending rules: ${listed.join(", ")}.`,
    input: { rules: wanted, refuseExisting: true },
  };
};

const proposeCategory = async (db: Db, userId: string, raw: ToolArgs): Promise<Proposal> => {
  const input = SpendingRuleChange.parse(raw);
  const pattern = input.pattern.toUpperCase();
  const category = knownCategory(input.category);
  const rule = (await rulesFor(db, userId)).find((stored) => stored.pattern === pattern);
  if (rule === undefined) throw new Error("No such rule. Check get_spending_rules");
  if (rule.category === category) throw new Error("The rule is already in that category");
  const from = labelForCategory(rule.category);
  const to = labelForCategory(category);
  return {
    proposalId: newId(),
    action: "spending_rule_category",
    title: "Move a spending rule",
    facts: [
      { kind: "code", label: "Rule", code: pattern },
      text("From", from),
      text("To", to),
      text("Made by", RULE_MADE_BY[rule.source]),
      ...(rule.source === "user" ? [text("Your own rule", "Replaces your own rule")] : []),
    ],
    summary:
      `Move the spending rule ${pattern} from ${from} to ${to}` +
      (rule.source === "user" ? ", replacing the owner's own rule." : "."),
    input: { pattern, category, expectCategory: rule.category },
  };
};

export const buildRuleProposals = (db: Db, userId: string): ProposalTool[] => [
  {
    area: RULES,
    name: "propose_spending_rules",
    description:
      "Proposes categorisation rules so payees go to the right category: rules of {pattern, " +
      "category}, pattern part of a payee name you saw in get_uncategorised_spending or " +
      `get_transaction_class, category one of ${CATEGORIES}. The owner's confirmed rules are theirs.` +
      AWAITS,
    schema: SpendingRulesSave,
    propose: (input) => proposeRules(db, userId, input),
  },
  {
    area: RULES,
    name: "propose_spending_rule_category",
    description:
      "Proposes moving one existing rule (pattern from get_spending_rules) to another category, " +
      "when the categorisation went wrong." +
      AWAITS,
    schema: SpendingRuleChange,
    propose: (input) => proposeCategory(db, userId, input),
  },
];

import { z } from "zod";

import {
  AdjustSave,
  BalanceSave,
  CashEntry,
  CashEntryRemove,
  ConversationId,
  CreateAccount,
  CreateSnapshot,
  EditAccountInput,
  FundChargeInput,
  InstrumentCreate,
  InstrumentEdit,
  PlanRemoveInput,
  PlanSave,
  PriceInput,
  SnapshotQuery,
  SpendingRuleChange,
  SpendingRuleRemove,
  SpendingRulesSave,
  TargetAllocationInput,
  UndoInput,
} from "../action-inputs.ts";
import { ForecastRateInput, ForecastRateRemoveInput } from "../forecast-inputs.ts";

// No server-only imports: the chat page validates the streamed card with this.

const label = z.string().min(1).max(200);

/** One line of the card, built by the app from validated input and stored names; never model prose. */
export const FactSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), label, text: z.string().max(2000) }),
  z.object({
    kind: z.literal("money"),
    label,
    amount: z.string().regex(/^-?\d+\.\d{2}$/),
    currency: z.string().regex(/^[A-Z]{3}$/),
  }),
  z.object({ kind: z.literal("code"), label, code: z.string().max(2000) }),
]);

export type Fact = z.infer<typeof FactSchema>;

const base = {
  proposalId: z.string().min(1).max(64),
  /** The sentence the model reads in later turns; built like `facts`, so never holds the model's note. */
  summary: z.string().min(1).max(4000),
  title: z.string().min(1).max(200),
  facts: z.array(FactSchema).max(220),
};

/** What the assistant may propose; `input` is exactly what the action's own server function takes. */
export const ProposalSchema = z.discriminatedUnion("action", [
  z.object({ ...base, action: z.literal("record_price"), input: PriceInput }),
  z.object({ ...base, action: z.literal("cash_entry"), input: CashEntry }),
  z.object({ ...base, action: z.literal("target_allocation"), input: TargetAllocationInput }),
  z.object({ ...base, action: z.literal("price_source"), input: InstrumentEdit }),
  z.object({ ...base, action: z.literal("monthly_plan"), input: PlanSave }),
  z.object({ ...base, action: z.literal("create_account"), input: CreateAccount }),
  z.object({ ...base, action: z.literal("edit_account"), input: EditAccountInput }),
  z.object({ ...base, action: z.literal("account_balance"), input: BalanceSave }),
  z.object({ ...base, action: z.literal("create_instrument"), input: InstrumentCreate }),
  z.object({ ...base, action: z.literal("fund_fee"), input: FundChargeInput }),
  z.object({ ...base, action: z.literal("forecast_rate"), input: ForecastRateInput }),
  z.object({ ...base, action: z.literal("snapshot"), input: CreateSnapshot }),
  z.object({ ...base, action: z.literal("snapshot_adjust"), input: AdjustSave }),
  z.object({ ...base, action: z.literal("spending_rules"), input: SpendingRulesSave }),
  z.object({ ...base, action: z.literal("spending_rule_category"), input: SpendingRuleChange }),
  z.object({ ...base, action: z.literal("delete_cash_entry"), input: CashEntryRemove }),
  z.object({ ...base, action: z.literal("delete_plan_row"), input: PlanRemoveInput }),
  z.object({ ...base, action: z.literal("delete_spending_rule"), input: SpendingRuleRemove }),
  z.object({ ...base, action: z.literal("remove_snapshot"), input: SnapshotQuery }),
  z.object({ ...base, action: z.literal("undo_import"), input: UndoInput }),
  z.object({ ...base, action: z.literal("remove_conversation"), input: ConversationId }),
  z.object({ ...base, action: z.literal("clear_fund_fee"), input: FundChargeInput }),
  z.object({ ...base, action: z.literal("clear_forecast_rate"), input: ForecastRateRemoveInput }),
]);

export type Proposal = z.infer<typeof ProposalSchema>;
export type ProposalAction = Proposal["action"];

/** Every action by name; `satisfies` makes a new action fail to compile until it is listed here. */
const ACTION_NAMES = {
  record_price: "record_price",
  cash_entry: "cash_entry",
  target_allocation: "target_allocation",
  price_source: "price_source",
  monthly_plan: "monthly_plan",
  create_account: "create_account",
  edit_account: "edit_account",
  account_balance: "account_balance",
  create_instrument: "create_instrument",
  fund_fee: "fund_fee",
  forecast_rate: "forecast_rate",
  snapshot: "snapshot",
  snapshot_adjust: "snapshot_adjust",
  spending_rules: "spending_rules",
  spending_rule_category: "spending_rule_category",
  delete_cash_entry: "delete_cash_entry",
  delete_plan_row: "delete_plan_row",
  delete_spending_rule: "delete_spending_rule",
  remove_snapshot: "remove_snapshot",
  undo_import: "undo_import",
  remove_conversation: "remove_conversation",
  clear_fund_fee: "clear_fund_fee",
  clear_forecast_rate: "clear_forecast_rate",
} as const satisfies Record<ProposalAction, ProposalAction>;

type Removal = { readonly button: string; readonly after: string };

const FINAL = "This cannot be undone.";

/** The actions that remove data, by action: the card's warning style, its button and its last line all come from here. */
const REMOVALS = new Map<ProposalAction, Removal>([
  ["delete_cash_entry", { button: "Delete", after: FINAL }],
  ["delete_plan_row", { button: "Delete", after: FINAL }],
  ["delete_spending_rule", { button: "Delete", after: FINAL }],
  ["remove_snapshot", { button: "Delete", after: FINAL }],
  [
    "undo_import",
    { button: "Undo import", after: "Importing the file again brings its rows back." },
  ],
  ["remove_conversation", { button: "Delete", after: FINAL }],
  ["clear_fund_fee", { button: "Delete", after: "A fee lookup may fill it in again." }],
  ["clear_forecast_rate", { button: "Delete", after: FINAL }],
]);

export const removalOf = (action: ProposalAction): Removal | null => REMOVALS.get(action) ?? null;

/** What a card's button says: a removal names itself, so it can never pass for an ordinary save. */
export const confirmLabel = (action: ProposalAction): string =>
  removalOf(action)?.button ?? "Confirm";

/** The stored trace of a proposal: what the card showed, never the input, so a reloaded thread cannot replay it. */
export const StoredProposal = z.object({
  ...base,
  action: z.enum(ACTION_NAMES),
});

/** A row the app stored itself; a malformed one reads as null rather than failing the page or the turn. */
export const readStored = <T>(schema: z.ZodType<T>, text: string): T | null => {
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

export const ProposalOutcome = z.enum(["saved", "failed", "dismissed"]);

/** What the owner did with one, as stored in a `note` row. */
export const StoredOutcome = z.object({
  proposalId: base.proposalId,
  outcome: ProposalOutcome,
  detail: z.string().max(300).optional(),
});

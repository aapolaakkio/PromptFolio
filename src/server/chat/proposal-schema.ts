import { z } from "zod";

import {
  CashEntry,
  InstrumentEdit,
  PlanSave,
  PriceInput,
  TargetAllocationInput,
} from "../action-inputs.ts";

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
]);

export type Proposal = z.infer<typeof ProposalSchema>;
export type ProposalAction = Proposal["action"];

/** The stored trace of a proposal: what the card showed, never the input, so a reloaded thread cannot replay it. */
export const StoredProposal = z.object({
  ...base,
  action: z.enum([
    "record_price",
    "cash_entry",
    "target_allocation",
    "price_source",
    "monthly_plan",
  ]),
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

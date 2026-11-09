import { z } from "zod";

import { CashEntry, InstrumentEdit, PriceInput, TargetAllocationInput } from "../action-inputs.ts";

// No server-only imports: the chat page validates the streamed card with this.

const base = {
  proposalId: z.string().min(1).max(64),
  summary: z.string().min(1).max(4000),
};

/** What the assistant may propose; `input` is exactly what the action's own server function takes. */
export const ProposalSchema = z.discriminatedUnion("action", [
  z.object({ ...base, action: z.literal("record_price"), input: PriceInput }),
  z.object({ ...base, action: z.literal("cash_entry"), input: CashEntry }),
  z.object({ ...base, action: z.literal("target_allocation"), input: TargetAllocationInput }),
  z.object({ ...base, action: z.literal("price_source"), input: InstrumentEdit }),
]);

export type Proposal = z.infer<typeof ProposalSchema>;
export type ProposalAction = Proposal["action"];

/** The stored trace of a proposal: summary only, never the input, so a reloaded thread cannot replay it. */
export const StoredProposal = z.object({
  proposalId: base.proposalId,
  action: z.enum(["record_price", "cash_entry", "target_allocation", "price_source"]),
  summary: base.summary,
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

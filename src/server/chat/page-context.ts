import { z } from "zod";

/** The pages the assistant panel can be opened on; the app decides which one, never the model. */
export const ASSISTANT_PAGES = [
  "dashboard",
  "holdings",
  "reconcile",
  "cash",
  "spending",
  "rebalance",
  "forecast",
  "tax",
  "imports",
  "chat",
] as const;

export type AssistantPage = (typeof ASSISTANT_PAGES)[number];

const Id = z.number().int().positive();

/** Only ids travel: the names the model sees are looked up in the caller's own records. */
export const PageContext = z
  .object({
    page: z.enum(ASSISTANT_PAGES),
    selection: z
      .object({ accountId: Id.optional(), instrumentId: Id.optional() })
      .strict()
      .optional(),
  })
  .strict();

export type PageContext = z.infer<typeof PageContext>;

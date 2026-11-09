import type { QueryClient } from "@tanstack/react-query";

import type { CardOutcome } from "./proposal-actions.ts";

/**
 * The one refresh after a card is decided. A save can touch any page, so every query refetches and
 * the page behind the panel shows it at once; otherwise only the transcript. `null` is the decider
 * refusing a second decision, which refreshes nothing.
 */
export const refreshAfterDecision = (
  client: Pick<QueryClient, "invalidateQueries">,
  outcome: CardOutcome | null,
): void => {
  if (outcome === null) return;
  if (outcome.outcome === "saved") void client.invalidateQueries();
  else void client.invalidateQueries({ queryKey: ["conversation"] });
};

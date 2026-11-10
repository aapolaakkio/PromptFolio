import type { QueryClient } from "@tanstack/react-query";

import type { CardOutcome } from "./proposal-actions.ts";

/** The one refresh after a card is decided. A save can touch any page, so every query refetches and the page behind the panel shows it at once; otherwise only the transcript. */
export const refreshAfterDecision = (
  client: Pick<QueryClient, "invalidateQueries">,
  outcome: CardOutcome,
): void => {
  if (outcome.outcome === "saved") void client.invalidateQueries();
  else void client.invalidateQueries({ queryKey: ["conversation"] });
};

import { hasStandIn, maskAccountNumbers } from "./mask.ts";
import { mentionsName } from "./owner-name.ts";

/**
 * True when a web search query holds something personal: what the masker hides (account numbers, identity codes, emails, card and phone numbers), a mask the model was shown, or the owner's name.
 * The search has already run on Anthropic's side by the time the app sees it, so this only flags it for the owner.
 */
export const isPersonalQuery = (query: string, ownerName: string | null): boolean =>
  maskAccountNumbers(query) !== query || hasStandIn(query) || mentionsName(query, ownerName);

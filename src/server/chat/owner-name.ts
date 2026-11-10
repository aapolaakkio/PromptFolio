import { AsyncLocalStorage } from "node:async_hooks";

import type { ChatMessage, TurnParams } from "./runner.ts";

const request = new AsyncLocalStorage<string>();

/** Runs a signed-in request with the owner's name known to every model client made inside it. */
export const withOwnerName = <T>(name: string, run: () => T): T => request.run(name, run);

export const ownerNameNow = (): string | null => request.getStore() ?? null;

// ponytail: a part under three letters ("Bo", "Li") is not hidden, it would also hide ordinary words; add an owner-set alias list if that matters.
const MIN_PART_LETTERS = 3;
const NOTE =
  'Privacy: the owner\'s own name is shown to you as x characters of the same length (in a file, the real text has the real name). Never match or repeat those x characters as a name; call the owner "you".';

const literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

const namePattern = (name: string): RegExp | null => {
  const parts = name
    .split(/\s+/)
    .filter((part) => (part.match(/\p{L}/gu)?.length ?? 0) >= MIN_PART_LETTERS);
  return parts.length === 0
    ? null
    : new RegExp(String.raw`(?<!\p{L})(?:${parts.map(literal).join("|")})(?!\p{L})`, "giu");
};

/**
 * What a model is sent, with the owner's name replaced in everything the app wrote (system, user and tool messages).
 * The model's own earlier replies are left as they were: they were written from text that was already hidden.
 */
export const hidingOwnerName = (params: TurnParams, name: string | null): TurnParams => {
  const pattern = name === null ? null : namePattern(name);
  if (pattern === null) return params;
  const hide = (text: string): string =>
    text.replace(pattern, (found) => found.replace(/\p{L}/gu, "x"));
  const first = params.messages.findIndex((message) => message.role === "system");
  return {
    ...params,
    messages: params.messages.map((message, at): ChatMessage => {
      if (message.role === "assistant") return message;
      const content = hide(message.content);
      return { ...message, content: at === first ? `${content}\n\n${NOTE}` : content };
    }),
  };
};

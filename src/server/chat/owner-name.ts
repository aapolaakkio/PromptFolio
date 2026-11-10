import { AsyncLocalStorage } from "node:async_hooks";

import type { ChatMessage, TurnParams } from "./runner.ts";

const request = new AsyncLocalStorage<string>();

/** Runs a signed-in request with the owner's name known to every model client made inside it. */
export const withOwnerName = <T>(name: string, run: () => T): T => request.run(name, run);

export const ownerNameNow = (): string | null => request.getStore() ?? null;

const MIN_LONE_LETTERS = 3;
const NOTE =
  'Privacy: the owner\'s own name is shown to you as x characters of the same length (in a file, the real text has the real name). Never match or repeat those x characters as a name; call the owner "you".';

const literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

/**
 * Two or more parts of the name side by side, in any order ("Virtanen, Matti"). One part alone is not hidden: it would also hide a company, a ticker or a plain word.
 * ponytail: an inflected or decomposed (NFD) spelling is missed; add owner-set aliases if that matters.
 */
const namePattern = (name: string): RegExp | null => {
  const parts = name
    .normalize("NFC")
    .split(/[\s,]+/)
    .filter((part) => /\p{L}/u.test(part));
  if (parts.length === 0) return null;
  const part = `(?:${parts.map(literal).join("|")})`;
  const [only] = parts;
  if (parts.length === 1 && (only?.match(/\p{L}/gu)?.length ?? 0) < MIN_LONE_LETTERS) return null;
  const body = parts.length === 1 ? part : String.raw`${part}(?:[\s,]{1,3}${part})+`;
  return new RegExp(String.raw`(?<!\p{L})${body}(?!\p{L})`, "giu");
};

/**
 * What a model is sent, with the owner's name replaced in every message text, earlier answers included (one stored before this existed may hold the name).
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
      const content = hide(message.content);
      return { ...message, content: at === first ? `${content}\n\n${NOTE}` : content };
    }),
  };
};

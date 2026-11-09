import { z } from "zod";

import type { Currency } from "../../core/money.ts";
import { createClient, type ChatClient, type ServerTool } from "../chat/runner.ts";
import { RECIPE_MODEL } from "../import/recipe/ask.ts";

export type PageFinder = (q: {
  readonly isin: string | null;
  readonly name: string;
  readonly currency: Currency | null;
}) => Promise<{ url: string; isin: string | null } | null>;

/** What the lookup needs to find and verify a page; the reference price is added per row. */
export type PageDeps = { readonly find: PageFinder; readonly client: ChatClient };

/** Searches in one turn. More than a few means the model is wandering, not finding. */
const MAX_SEARCHES = 5;
const MAX_TOKENS = 16000;

export const WEB_SEARCH_TOOL: ServerTool = {
  type: "web_search_20260318",
  name: "web_search",
  max_uses: MAX_SEARCHES,
};

const ISIN = /^[A-Z]{2}[A-Z0-9]{9}\d$/;

const Found = z.object({
  url: z.url({ protocol: /^https$/ }).nullable(),
  isin: z.string().nullable().catch(null),
});

const INSTRUCTIONS = `Etsit verkkosivun, jolla näkyy yhden rahaston tai arvopaperin osuuden arvo (NAV) ja sen päivä.
- Suosi rahastoyhtiön tai välittäjän omaa sivua, jolla on vain tämän yhden rahaston tiedot. Älä valitse listaa, jossa on monen rahaston arvoja.
- Sivun on oltava https-osoite, jonka voi hakea suoraan ilman kirjautumista.
- Jos sivulla näkyy rahaston ISIN-tunnus, kerro se. Älä arvaa ISIN-tunnusta.
- Vastaa lopuksi pelkällä JSON-oliolla {"url": "...", "isin": "..."}. Jos et löytänyt sivua, url on null. Jos ISIN-tunnusta ei näy, isin on null.`;

const question = (q: Parameters<PageFinder>[0]): string =>
  [
    `Nimi: ${q.name}`,
    `ISIN: ${q.isin ?? "ei tiedossa"}`,
    `Valuutta: ${q.currency ?? "ei tiedossa"}`,
  ].join("\n");

/** The outermost `{...}` in the reply, read as `Found`: the model may write a sentence around it. */
const readFound = (text: string): z.infer<typeof Found> | null => {
  const from = text.indexOf("{");
  const to = text.lastIndexOf("}");
  if (from === -1 || to < from) return null;
  try {
    const parsed = Found.safeParse(JSON.parse(text.slice(from, to + 1)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

/**
 * One model turn with Claude's web search. Whatever it answers is only a
 * candidate: the lookup fetches the page and a recipe has to read the price
 * off it before anything is trusted. A thrown error propagates, so the lookup
 * can say "pending" rather than "nothing found".
 */
export const webSearchFinder =
  (client: ChatClient): PageFinder =>
  async (q) => {
    // ponytail: structured output can't carry web search's cited text blocks,
    // so the JSON is asked for in the reply and read with zod. A turn cut off
    // at pause_turn reads as nothing found and is retried with the form's 7 days.
    const reply = await client.run({
      model: RECIPE_MODEL,
      max_tokens: MAX_TOKENS,
      messages: [
        { role: "system", content: INSTRUCTIONS },
        { role: "user", content: question(q) },
      ],
      tools: [WEB_SEARCH_TOOL],
    });
    const found = readFound(reply.text);
    if (found === null || found.url === null) return null;
    const isin = found.isin !== null && ISIN.test(found.isin) ? found.isin : null;
    return { url: found.url, isin };
  };

/** The production finder, or null when no model is configured: the lookup then runs without it. */
export const pageDeps = (): PageDeps | null => {
  try {
    const client = createClient();
    return { find: webSearchFinder(client), client };
  } catch {
    return null;
  }
};

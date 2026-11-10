import { z } from "zod";

// No server-only imports: the chat page validates streamed and stored searches with this.

export const MAX_QUERY = 2000;
export const MAX_TITLE = 300;
export const MAX_URL = 2000;
const MAX_REASON = 200;
export const MAX_SOURCES = 50;

export const WebSourceSchema = z.object({
  title: z.string().max(MAX_TITLE),
  url: z.string().max(MAX_URL),
});
export type WebSource = z.infer<typeof WebSourceSchema>;

export const SearchEventSchemas = [
  z.object({
    type: z.literal("search"),
    id: z.string(),
    query: z.string().max(MAX_QUERY),
    personal: z.boolean(),
  }),
  z.object({
    type: z.literal("search_failed"),
    id: z.string(),
    reason: z.string().max(MAX_REASON),
  }),
  z.object({ type: z.literal("sources"), sources: z.array(WebSourceSchema) }),
] as const;

const SearchEventSchema = z.union(SearchEventSchemas);
export type SearchEvent = z.infer<typeof SearchEventSchema>;

const SearchLineSchema = z.object({
  id: z.string(),
  query: z.string().max(MAX_QUERY),
  personal: z.boolean(),
  failed: z.string().max(MAX_REASON).nullable(),
});

/** One answer's searches and the sources it cited, kept as one `search` row of the conversation. */
export const StoredSearchSchema = z.object({
  searches: z.array(SearchLineSchema),
  sources: z.array(WebSourceSchema),
});
export type StoredSearch = z.infer<typeof StoredSearchSchema>;

export const NO_SEARCH: StoredSearch = { searches: [], sources: [] };

const failLine = (web: StoredSearch, id: string, reason: string): StoredSearch => {
  const known = web.searches.some((line) => line.id === id);
  const searches = known
    ? web.searches.map((line) => (line.id === id ? { ...line, failed: reason } : line))
    : [...web.searches, { id, query: "", personal: false, failed: reason }];
  return { ...web, searches };
};

/** The record with one streamed event applied; a repeated query or source is kept once. */
export const addSearchEvent = (web: StoredSearch, event: SearchEvent): StoredSearch => {
  switch (event.type) {
    case "search": {
      if (web.searches.some((line) => line.id === event.id)) return web;
      const { id, query, personal } = event;
      return { ...web, searches: [...web.searches, { id, query, personal, failed: null }] };
    }
    case "search_failed":
      return failLine(web, event.id, event.reason);
    case "sources": {
      const fresh = event.sources.filter(
        (source) => !web.sources.some((known) => known.url === source.url),
      );
      return { ...web, sources: [...web.sources, ...fresh].slice(0, MAX_SOURCES) };
    }
  }
};

export const hasSearch = (web: StoredSearch): boolean =>
  web.searches.length > 0 || web.sources.length > 0;

/** A web address safe to link to: http or https only; anything else is shown as text. */
export const webUrl = (text: string): string | null => {
  try {
    const url = new URL(text);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
};

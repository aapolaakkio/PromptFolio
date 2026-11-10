import { describe, expect, test } from "vitest";

import {
  addSearchEvent,
  MAX_SOURCES,
  NO_SEARCH,
  webUrl,
  type SearchEvent,
} from "./search-schema.ts";

describe("addSearchEvent", () => {
  test("keeps each search once, marks a failure on its line, and each source once", () => {
    const steps: SearchEvent[] = [
      { type: "search", id: "a", query: "Acme Oyj", personal: false },
      { type: "search", id: "a", query: "Acme Oyj", personal: false },
      { type: "search_failed", id: "a", reason: "the search service is unavailable" },
      { type: "sources", sources: [{ title: "Acme", url: "https://example.com/a" }] },
      { type: "sources", sources: [{ title: "Acme again", url: "https://example.com/a" }] },
    ];
    const web = steps.reduce(addSearchEvent, NO_SEARCH);

    expect(web).toEqual({
      searches: [
        {
          id: "a",
          query: "Acme Oyj",
          personal: false,
          failed: "the search service is unavailable",
        },
      ],
      sources: [{ title: "Acme", url: "https://example.com/a" }],
    });
    expect(NO_SEARCH).toEqual({ searches: [], sources: [] });
  });
});

test("keeps at most fifty sources per answer", () => {
  const sources = Array.from({ length: 60 }, (_, at) => ({
    title: `Page ${at}`,
    url: `https://example.com/${at}`,
  }));
  const web = addSearchEvent(addSearchEvent(NO_SEARCH, { type: "sources", sources }), {
    type: "sources",
    sources: [{ title: "Late", url: "https://example.com/late" }],
  });

  expect(MAX_SOURCES).toBe(50);
  expect(web.sources).toEqual(sources.slice(0, 50));
});

describe("webUrl", () => {
  test("links only http and https addresses", () => {
    expect(webUrl("https://www.vero.fi/henkiloasiakkaat/")).toBe(
      "https://www.vero.fi/henkiloasiakkaat/",
    );
    expect(webUrl("http://example.com")).toBe("http://example.com/");
    expect(webUrl("javascript:alert(1)")).toBeNull();
    expect(webUrl("data:text/html,hi")).toBeNull();
    expect(webUrl("not a url")).toBeNull();
  });
});

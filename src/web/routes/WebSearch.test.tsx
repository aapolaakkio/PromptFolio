import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { SearchTurn, WebSearchSwitch } from "./WebSearch.tsx";

const noop = () => {};

describe("SearchTurn", () => {
  test("shows each search, a warning on a personal one, and a failed one's reason", () => {
    const html = renderToStaticMarkup(
      <SearchTurn
        web={{
          searches: [
            { id: "a", query: "Acme Oyj tender offer", personal: false, failed: null },
            { id: "b", query: "FI21 1234 5600 0007 85", personal: true, failed: null },
            { id: "c", query: "Acme NAV", personal: false, failed: "too many searches right now" },
          ],
          sources: [],
        }}
      />,
    );

    expect(html).toContain("Searched the web: Acme Oyj tender offer");
    expect(html).toContain("Searched the web: FI21 1234 5600 0007 85");
    expect(html).toContain("this search included personal data");
    expect(html.match(/included personal data/g)).toHaveLength(1);
    expect(html).toContain("Web search failed: too many searches right now");
  });

  test("lists sources as links that open apart, with the title as text, never as HTML", () => {
    const html = renderToStaticMarkup(
      <SearchTurn
        web={{
          searches: [],
          sources: [
            { title: "Offer <b>document</b>", url: "https://example.com/offer" },
            { title: "Not a link", url: "javascript:alert(1)" },
          ],
        }}
      />,
    );

    expect(html).toContain(
      '<a href="https://example.com/offer" target="_blank" rel="noopener noreferrer">Offer &lt;b&gt;document&lt;/b&gt;</a>',
    );
    expect(html).not.toContain('href="javascript');
    expect(html).toContain("Not a link");
  });
});

describe("WebSearchSwitch", () => {
  test("is a labelled switch, off unless turned on, with its help line", () => {
    const off = renderToStaticMarkup(<WebSearchSwitch on={false} busy={false} onChange={noop} />);
    const on = renderToStaticMarkup(<WebSearchSwitch on busy={false} onChange={noop} />);

    expect(off).toContain('role="switch"');
    expect(off).toContain("Web search");
    expect(off).not.toContain("checked");
    expect(on).toContain('checked=""');
    expect(off).toContain("search words go to a search engine through Claude");
  });
});

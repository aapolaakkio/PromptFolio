import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { Markdown } from "./Markdown.tsx";

describe("Markdown", () => {
  test("renders the shapes an answer is written in", () => {
    const html = renderToStaticMarkup(
      <Markdown text={"## Yhteenveto\n\nKului **73,35 €**.\n\n- ruoka\n- liikenne"} />,
    );

    expect(html).toContain("<h4");
    expect(html).toContain("<strong>73,35 €</strong>");
    expect(html).toContain("<ul");
    expect(html).toContain("<li>");
  });

  test("renders a table of figures as a table", () => {
    const html = renderToStaticMarkup(
      <Markdown text={"| Luokka | Summa |\n| --- | --- |\n| Ruoka | -73,35 |"} />,
    );

    expect(html).toContain("<th>");
    expect(html).toContain("-73,35");
  });

  test("puts an answer's own markup on the page as text, never as markup", () => {
    // The worst case this design exists for: an answer quoting a payee whose
    // name came out of an imported statement, with a tag in it. React escapes
    // it because it is a string in an element, not a string in a document --
    // and there is no HTML-building step anywhere for it to slip through.
    const html = renderToStaticMarkup(
      <Markdown text={'Maksettu kohteelle <img src=x onerror="alert(1)"> eilen'} />,
    );

    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  test("renders italics, inline code and a code block", () => {
    const html = renderToStaticMarkup(
      <Markdown text={"Katso *tarkka* `get_holdings`.\n\n```\nrivi\n```"} />,
    );

    expect(html).toContain("<em>tarkka</em>");
    expect(html).toContain("<code");
    expect(html).toContain("<pre");
  });

  test("renders nothing for an empty answer", () => {
    expect(renderToStaticMarkup(<Markdown text="" />)).toBe('<div class="grid gap-2"></div>');
  });
});

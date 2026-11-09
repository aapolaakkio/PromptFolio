import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { Markdown } from "./Markdown.tsx";

describe("Markdown", () => {
  test("renders the shapes an answer is written in", () => {
    const html = renderToStaticMarkup(
      <Markdown text={"## Summary\n\nSpent **€73.35**.\n\n- food\n- transport"} />,
    );

    expect(html).toContain("<h4");
    expect(html).toContain("<strong>€73.35</strong>");
    expect(html).toContain("<ul");
    expect(html).toContain("<li>");
  });

  test("renders a table of figures as a table", () => {
    const html = renderToStaticMarkup(
      <Markdown text={"| Category | Amount |\n| --- | --- |\n| Food | -73.35 |"} />,
    );

    expect(html).toContain("<th>");
    expect(html).toContain("-73.35");
  });

  test("puts an answer's own markup on the page as text, never as markup", () => {
    // The worst case: a payee name from a statement containing a tag; React escapes it as a string in an element.
    const html = renderToStaticMarkup(
      <Markdown text={'Paid to <img src=x onerror="alert(1)"> yesterday'} />,
    );

    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  test("renders italics, inline code and a code block", () => {
    const html = renderToStaticMarkup(
      <Markdown text={"See *exact* `get_holdings`.\n\n```\nline\n```"} />,
    );

    expect(html).toContain("<em>exact</em>");
    expect(html).toContain("<code");
    expect(html).toContain("<pre");
  });

  test("renders nothing for an empty answer", () => {
    expect(renderToStaticMarkup(<Markdown text="" />)).toBe('<div class="grid gap-2"></div>');
  });
});

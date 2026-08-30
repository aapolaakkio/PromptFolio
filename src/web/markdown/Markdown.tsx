import { type ReactNode } from "react";

import { type Block, type Inline, parseMarkdown } from "./parse";

const spanOf = (span: Inline, key: number): ReactNode => {
  if (span.type === "bold") return <strong key={key}>{span.text}</strong>;
  if (span.type === "italic") return <em key={key}>{span.text}</em>;
  if (span.type === "code") {
    return (
      <code key={key} className="rounded bg-bg px-1 py-0.5 text-[0.9em]">
        {span.text}
      </code>
    );
  }
  return <span key={key}>{span.text}</span>;
};

const spans = (parts: readonly Inline[]): ReactNode[] =>
  parts.map((part, index) => spanOf(part, index));

const blockOf = (block: Block, key: number): ReactNode => {
  if (block.type === "heading") {
    // Two levels down from the page's own: an answer's "# Yhteenveto" is a
    // heading inside one message, not a rival to the page title.
    // SAFETY: the parser only ever produces levels 1 to 3, so the tag is one of
    // h3, h4 and h5 -- all three of them real elements.
    const Tag = `h${block.level + 2}` as "h3" | "h4" | "h5";
    return (
      <Tag key={key} className="text-base font-medium">
        {spans(block.spans)}
      </Tag>
    );
  }
  if (block.type === "list") {
    const Tag = block.ordered ? "ol" : "ul";
    return (
      <Tag key={key} className={`ml-5 grid gap-1 ${block.ordered ? "list-decimal" : "list-disc"}`}>
        {block.items.map((item, index) => (
          <li key={index}>{spans(item)}</li>
        ))}
      </Tag>
    );
  }
  if (block.type === "code") {
    return (
      <pre key={key} className="overflow-x-auto rounded bg-bg p-3 text-sm">
        <code>{block.text}</code>
      </pre>
    );
  }
  if (block.type === "table") {
    return (
      // A table of figures is the one thing here that can be wider than the
      // bubble holding it, so it scrolls inside it rather than stretching the
      // page sideways.
      <div key={key} className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              {block.header.map((cell, index) => (
                <th key={index}>{spans(cell)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, index) => (
                  <td key={index}>{spans(cell)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return <p key={key}>{spans(block.spans)}</p>;
};

/**
 * An assistant's answer, rendered from the Markdown it wrote.
 *
 * Elements all the way down: nothing here builds an HTML string, so an answer
 * quoting a payee's own text -- which came out of an imported statement and is
 * not something this app wrote -- cannot carry markup into the page.
 */
export const Markdown = ({ text }: { readonly text: string }) => (
  <div className="grid gap-2">{parseMarkdown(text).map(blockOf)}</div>
);

import { type ReactNode } from "react";

import { type Block, type Inline, parseMarkdown } from "./parse.ts";

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
    // Two levels below the page heading: an answer's "# Summary" is not a rival to the page title.
    // SAFETY: the parser only produces levels 1-3, so the tag is h3, h4 or h5.
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
      // A table of figures can outgrow its bubble: scroll inside it, not the page.
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

/** An assistant answer rendered as elements, never an HTML string, so quoted statement text cannot carry markup. */
export const Markdown = ({ text }: { readonly text: string }) => (
  <div className="grid gap-2">{parseMarkdown(text).map(blockOf)}</div>
);

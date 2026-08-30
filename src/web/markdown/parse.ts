/**
 * Enough Markdown for what the assistant writes, and deliberately no more.
 *
 * The model answers in prose with lists and the occasional table of figures,
 * and until now every one of those arrived as a wall of asterisks and pipes.
 * This parses the shapes it actually emits -- headings, lists, tables, code,
 * bold, italic -- into a tree the renderer turns into React elements.
 *
 * It produces a tree rather than HTML on purpose. An answer can quote a payee's
 * own text, which came out of a bank statement and is not something this app
 * wrote; building HTML from it and injecting the string would make every
 * imported file a place to put markup. Elements cannot carry markup, so the
 * question never arises.
 *
 * What it leaves out, because the model does not write it and each one is a way
 * to be wrong: nested lists, images, footnotes, and links -- a link's text is
 * kept and its target dropped, since a clickable destination assembled from
 * statement text is a phishing surface with nothing on the other end of it.
 */

export type Inline = {
  readonly type: "text" | "bold" | "italic" | "code";
  readonly text: string;
};

export type Block =
  | { readonly type: "paragraph"; readonly spans: readonly Inline[] }
  | { readonly type: "heading"; readonly level: 1 | 2 | 3; readonly spans: readonly Inline[] }
  | {
      readonly type: "list";
      readonly ordered: boolean;
      readonly items: readonly (readonly Inline[])[];
    }
  | { readonly type: "code"; readonly text: string }
  | {
      readonly type: "table";
      readonly header: readonly (readonly Inline[])[];
      readonly rows: readonly (readonly (readonly Inline[])[])[];
    };

/** Code first, so a `**` inside backticks stays the characters it is. */
const INLINE_PATTERN = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_)/;

/** `[text](target)` keeps its text; see the note on links above. */
const LINK_PATTERN = /\[([^\]]+)\]\([^)]*\)/g;

export const parseInline = (text: string): Inline[] => {
  const spans: Inline[] = [];
  for (const piece of text.replace(LINK_PATTERN, "$1").split(INLINE_PATTERN)) {
    if (piece === "") continue;
    if (piece.startsWith("`") && piece.endsWith("`")) {
      spans.push({ type: "code", text: piece.slice(1, -1) });
    } else if (
      (piece.startsWith("**") && piece.endsWith("**")) ||
      (piece.startsWith("__") && piece.endsWith("__"))
    ) {
      spans.push({ type: "bold", text: piece.slice(2, -2) });
    } else if (
      (piece.startsWith("*") && piece.endsWith("*")) ||
      (piece.startsWith("_") && piece.endsWith("_"))
    ) {
      spans.push({ type: "italic", text: piece.slice(1, -1) });
    } else {
      spans.push({ type: "text", text: piece });
    }
  }
  return spans;
};

const cells = (line: string): Inline[][] =>
  line
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => parseInline(cell.trim()));

const isTableSeparator = (line: string): boolean => /^\|?[\s:-]*-[\s:|-]*\|?$/.test(line.trim());
const isTableRow = (line: string): boolean => line.trim().startsWith("|");

const HEADING = /^(#{1,3})\s+(.*)$/;
const BULLET = /^\s*[-*]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;

export const parseMarkdown = (source: string): Block[] => {
  const lines = source.split("\n");
  const blocks: Block[] = [];
  let index = 0;

  const paragraph: string[] = [];
  const flush = (): void => {
    if (paragraph.length === 0) return;
    blocks.push({ type: "paragraph", spans: parseInline(paragraph.join(" ")) });
    paragraph.length = 0;
  };

  while (index < lines.length) {
    const line = lines[index] ?? "";

    if (line.trim() === "") {
      flush();
      index += 1;
      continue;
    }

    if (line.trim().startsWith("```")) {
      flush();
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? "").trim().startsWith("```")) {
        body.push(lines[index] ?? "");
        index += 1;
      }
      // A fence the model never closed still shows its contents, rather than
      // swallowing the rest of the answer.
      index += 1;
      blocks.push({ type: "code", text: body.join("\n") });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      const level = heading[1]?.length ?? 1;
      blocks.push({
        type: "heading",
        // SAFETY: the pattern matches one to three '#', so the length is 1..3.
        level: level as 1 | 2 | 3,
        spans: parseInline(heading[2] ?? ""),
      });
      index += 1;
      continue;
    }

    if (isTableRow(line) && isTableSeparator(lines[index + 1] ?? "")) {
      flush();
      const header = cells(line);
      const rows: Inline[][][] = [];
      index += 2;
      while (index < lines.length && isTableRow(lines[index] ?? "")) {
        rows.push(cells(lines[index] ?? ""));
        index += 1;
      }
      blocks.push({ type: "table", header, rows });
      continue;
    }

    const ordered = NUMBERED.test(line);
    if (ordered || BULLET.test(line)) {
      flush();
      const items: Inline[][] = [];
      const pattern = ordered ? NUMBERED : BULLET;
      while (index < lines.length && pattern.test(lines[index] ?? "")) {
        items.push(parseInline(pattern.exec(lines[index] ?? "")?.[1] ?? ""));
        index += 1;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    paragraph.push(line.trim());
    index += 1;
  }

  flush();
  return blocks;
};

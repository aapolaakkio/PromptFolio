import { inflateSync } from "node:zlib";

/**
 * Pulls the text runs out of a PDF's content streams.
 *
 * The spec's §5.2 rule is text layer first, vision only when there is none, and
 * OP's year-end statement has a real one -- verified against a genuine 2-page
 * statement, whose two Flate-compressed content streams decode to 296 runs of
 * readable Finnish. So this path needs no model, no API key and no cost.
 *
 * Deliberately not a full PDF parser, and no dependency for one either. It
 * inflates each `stream ... endstream` object and lifts the literal strings a
 * text-showing operator would draw. That is enough for a statement laid out as
 * a table of labels and numbers, and it is honest about what it cannot do:
 * hex strings (`<...>`), text split mid-word across runs, and any glyph mapped
 * through a non-standard encoding all come back wrong or not at all. A caller
 * that finds no runs must treat the file as having no text layer rather than as
 * an empty statement -- `parseOpHoldings` does exactly that.
 */
export const extractPdfTextRuns = (bytes: Uint8Array): string[] => {
  const raw = new TextDecoder("latin1").decode(bytes);
  const runs: string[] = [];
  const streamStart = /stream\r?\n/g;

  let match: RegExpExecArray | null;
  while ((match = streamStart.exec(raw)) !== null) {
    const from = match.index + match[0].length;
    const to = raw.indexOf("endstream", from);
    if (to < 0) continue;

    let text: string;
    try {
      text = new TextDecoder("latin1").decode(inflateSync(bytes.slice(from, to)));
    } catch {
      // Not a Flate stream, or not a stream at all: an image, a font, or a
      // truncated object. Skipped rather than failing the file -- a statement's
      // logo must not stop its text from being read.
      continue;
    }

    for (const literal of text.matchAll(/\((?:[^()\\]|\\.)*\)/g)) {
      runs.push(literal[0].slice(1, -1).replaceAll("\\(", "(").replaceAll("\\)", ")"));
    }
  }
  return runs;
};

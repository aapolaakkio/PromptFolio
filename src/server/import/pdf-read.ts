/**
 * Reads a PDF with a model. The text layer comes out page by page, pages are
 * batched to fit the model's context, and each batch is asked to fill one of
 * three JSON shapes -- a bank statement, a holdings statement, a list of
 * transactions. Nothing here touches the ledger: a reading is a draft the
 * owner reviews, and its checks live with each flow.
 */

export type PdfPage = { readonly number: number; readonly text: string };

const NO_TEXT = "PDF ei sisällä tekstiä (skannattu kuva?); tuo tapahtumat CSV-muodossa";

/** One entry per page. Throws when the document has no text layer at all. */
export const extractPages = async (bytes: ArrayBuffer): Promise<PdfPage[]> => {
  const { extractText, getDocumentProxy } = await import("unpdf");
  // pdf.js takes ownership of the array it is given and detaches the buffer,
  // so a copy goes in: the caller hashes the same bytes afterwards.
  const pdf = await getDocumentProxy(new Uint8Array(bytes.slice(0)));
  const { text } = await extractText(pdf, { mergePages: false });
  const pages = text.map((pageText, index) => ({ number: index + 1, text: pageText }));
  if (pages.every((page) => page.text.trim() === "")) throw new Error(NO_TEXT);
  return pages;
};

const wordCount = (text: string): number => text.split(/\s+/).filter((w) => w !== "").length;

/** Roughly what the reading model takes comfortably with room for its answer. */
const DEFAULT_BATCH_WORDS = 6000;

/**
 * Consecutive pages grouped under a word budget. A page over the budget on its
 * own is still sent, alone: dropping it would drop its rows without a word.
 */
export const batchPages = (
  pages: readonly PdfPage[],
  maxWords: number = DEFAULT_BATCH_WORDS,
): PdfPage[][] => {
  const batches: PdfPage[][] = [];
  let current: PdfPage[] = [];
  let words = 0;
  for (const page of pages) {
    const size = wordCount(page.text);
    if (current.length > 0 && words + size > maxWords) {
      batches.push(current);
      current = [];
      words = 0;
    }
    current = [...current, page];
    words += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
};

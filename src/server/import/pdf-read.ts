/**
 * A PDF's text layer, page by page. What the text means is a recipe's job:
 * every PDF import reads this text through one.
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

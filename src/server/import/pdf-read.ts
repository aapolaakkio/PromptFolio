export type PdfPage = { readonly number: number; readonly text: string };

const NO_TEXT = "The PDF contains no text (scanned image?); import the transactions as CSV";

export const isPdf = (bytes: ArrayBuffer): boolean =>
  new TextDecoder().decode(bytes.slice(0, 5)) === "%PDF-";

export const extractPages = async (bytes: ArrayBuffer): Promise<PdfPage[]> => {
  const { extractText, getDocumentProxy } = await import("unpdf");
  // pdf.js detaches the buffer, so a copy goes in: the caller hashes the same bytes.
  const pdf = await getDocumentProxy(new Uint8Array(bytes.slice(0)));
  const { text } = await extractText(pdf, { mergePages: false });
  const pages = text.map((pageText, index) => ({ number: index + 1, text: pageText }));
  if (pages.every((page) => page.text.trim() === "")) throw new Error(NO_TEXT);
  return pages;
};

export type PdfPage = { readonly number: number; readonly text: string };

const NO_TEXT = "The PDF contains no text (scanned image?); import the transactions as CSV";

export const isPdf = (bytes: ArrayBuffer): boolean =>
  new TextDecoder().decode(bytes.slice(0, 5)) === "%PDF-";

/** The text of one page, as unpdf's `extractText` reads it. */
const pageText = async (
  pdf: Awaited<ReturnType<(typeof import("unpdf"))["getDocumentProxy"]>>,
  number: number,
): Promise<string> => {
  const content = await (await pdf.getPage(number)).getTextContent();
  return content.items
    .flatMap((item) => ("str" in item ? [item.str + (item.hasEOL ? "\n" : "")] : []))
    .join("");
};

/** With `maxPages` only that many leading pages are read, so a large file costs no more than a small one. */
export const extractPages = async (bytes: ArrayBuffer, maxPages?: number): Promise<PdfPage[]> => {
  const { extractText, getDocumentProxy } = await import("unpdf");
  // pdf.js detaches the buffer, so a copy goes in: the caller hashes the same bytes.
  const pdf = await getDocumentProxy(new Uint8Array(bytes.slice(0)));
  const text =
    maxPages === undefined
      ? (await extractText(pdf, { mergePages: false })).text
      : await Promise.all(
          Array.from({ length: Math.min(pdf.numPages, maxPages) }, (_, i) => pageText(pdf, i + 1)),
        );
  const pages = text.map((pageText, index) => ({ number: index + 1, text: pageText }));
  if (pages.every((page) => page.text.trim() === "")) throw new Error(NO_TEXT);
  return pages;
};

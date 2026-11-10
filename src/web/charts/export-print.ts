import { isoDay } from "./export-model.ts";

/** On `<html>` (value `page`) and on the one frame to print (value `frame`); the print stylesheet keys on both. */
export const PRINT_ATTRIBUTE = "data-print-chart";
/** The footer line, printed by the stylesheet as generated text. */
export const PRINT_FOOTER_ATTRIBUTE = "data-print-footer";
const MARKED = `[${PRINT_ATTRIBUTE}], [${PRINT_FOOTER_ATTRIBUTE}]`;

type Markable = {
  readonly setAttribute: (name: string, value: string) => void;
  readonly removeAttribute: (name: string) => void;
};

type MediaChange = (event: { readonly matches: boolean }) => void;

type PrintWindow = {
  readonly print: () => void;
  readonly addEventListener: (
    type: "afterprint",
    listener: () => void,
    options?: { once: boolean },
  ) => void;
  readonly matchMedia: (query: string) => {
    readonly addEventListener: (type: "change", listener: MediaChange) => void;
    readonly removeEventListener: (type: "change", listener: MediaChange) => void;
  };
};

type PrintDocument = {
  readonly documentElement: Markable;
  readonly querySelectorAll: (selector: string) => Iterable<Markable>;
};

type PrintOptions = {
  readonly title: string;
  readonly today: Date;
  readonly win: PrintWindow;
  readonly doc: PrintDocument;
};

const unmarkAll = (doc: PrintDocument): void => {
  for (const marked of doc.querySelectorAll(MARKED)) {
    marked.removeAttribute(PRINT_ATTRIBUTE);
    marked.removeAttribute(PRINT_FOOTER_ATTRIBUTE);
  }
};

/** Prints one chart through the browser's own dialog ("Save as PDF"): marks it, prints, and unmarks when the dialog is done. */
export const printChart = (frame: Markable, { title, today, win, doc }: PrintOptions): void => {
  const media = win.matchMedia("print");
  const onMedia: MediaChange = (event) => {
    if (!event.matches) clear();
  };
  const clear = (): void => {
    unmarkAll(doc);
    media.removeEventListener("change", onMedia);
  };
  // An earlier export whose end was never signalled would otherwise print beside this one.
  unmarkAll(doc);
  frame.setAttribute(PRINT_ATTRIBUTE, "frame");
  frame.setAttribute(PRINT_FOOTER_ATTRIBUTE, `${title} · PromptFolio · ${isoDay(today)}`);
  doc.documentElement.setAttribute(PRINT_ATTRIBUTE, "page");
  // Not straight after `print()`: some browsers return from it before the dialog closes. Two signals, since iOS can skip `afterprint`.
  win.addEventListener("afterprint", clear, { once: true });
  media.addEventListener("change", onMedia);
  try {
    win.print();
  } catch (error) {
    clear();
    throw error;
  }
};

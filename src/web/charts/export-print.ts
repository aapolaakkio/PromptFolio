import { isoDay } from "./export-model.ts";

/** On `<html>` (value `page`) and on the one frame to print (value `frame`); the print stylesheet keys on both. */
export const PRINT_ATTRIBUTE = "data-print-chart";
/** The footer line, printed by the stylesheet as generated text. */
export const PRINT_FOOTER_ATTRIBUTE = "data-print-footer";

type Markable = {
  readonly setAttribute: (name: string, value: string) => void;
  readonly removeAttribute: (name: string) => void;
};

type PrintWindow = {
  readonly print: () => void;
  readonly addEventListener: (
    type: "afterprint",
    listener: () => void,
    options?: { once: boolean },
  ) => void;
};

type PrintOptions = {
  readonly title: string;
  readonly today: Date;
  readonly win: PrintWindow;
  /** The document element. */
  readonly root: Markable;
};

/** Prints one chart through the browser's own dialog ("Save as PDF"): marks it, prints, and unmarks when the dialog is done. */
export const printChart = (frame: Markable, { title, today, win, root }: PrintOptions): void => {
  const clear = (): void => {
    frame.removeAttribute(PRINT_ATTRIBUTE);
    frame.removeAttribute(PRINT_FOOTER_ATTRIBUTE);
    root.removeAttribute(PRINT_ATTRIBUTE);
  };
  frame.setAttribute(PRINT_ATTRIBUTE, "frame");
  frame.setAttribute(PRINT_FOOTER_ATTRIBUTE, `${title} · PromptFolio · ${isoDay(today)}`);
  root.setAttribute(PRINT_ATTRIBUTE, "page");
  // Not straight after `print()`: some browsers return from it before the dialog closes.
  win.addEventListener("afterprint", clear, { once: true });
  try {
    win.print();
  } catch (error) {
    clear();
    throw error;
  }
};

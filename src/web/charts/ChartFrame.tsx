import {
  useId,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { exportFileName } from "./export-model.ts";
import { chartToPng, downloadBlob } from "./export-png.ts";
import { printChart } from "./export-print.ts";

type Export = (frame: HTMLElement, title: string) => void | Promise<void>;

const savePng: Export = async (frame, title) => {
  const blob = await chartToPng(frame, { title });
  downloadBlob(blob, exportFileName(title, "png", new Date()));
};

const savePdf: Export = (frame, title) =>
  printChart(frame, { title, today: new Date(), win: window, root: document.documentElement });

const FORMATS: readonly { readonly label: string; readonly run: Export }[] = [
  { label: "PNG", run: savePng },
  { label: "PDF", run: savePdf },
];

/** Up and down move between the menu's entries, as a menu's keyboard pattern expects. */
const stepFocus = (menu: HTMLElement, step: number): void => {
  const items = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]'));
  const current = items.findIndex((item) => item === document.activeElement);
  items[(current + step + items.length) % items.length]?.focus();
};

const ExportItems = ({
  id,
  title,
  onPick,
}: {
  readonly id: string;
  readonly title: string;
  readonly onPick: (action: Export) => void;
}) => (
  <div
    id={id}
    role="menu"
    aria-label={`Export ${title}`}
    className="absolute right-0 top-full z-10 grid rounded-md border border-line bg-surface p-1"
  >
    {FORMATS.map((format) => (
      <button
        key={format.label}
        type="button"
        role="menuitem"
        className="quiet-button text-left"
        onClick={() => onPick(format.run)}
      >
        {format.label}
      </button>
    ))}
  </div>
);

const ExportMenu = ({
  title,
  frameRef,
}: {
  readonly title: string;
  readonly frameRef: RefObject<HTMLElement | null>;
}) => {
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  const run = (action: Export): void => {
    setOpen(false);
    setFailed(false);
    const frame = frameRef.current;
    if (frame === null) return;
    Promise.resolve()
      .then(() => action(frame, title))
      .catch(() => setFailed(true));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (!open) return;
    if (event.key === "Escape") {
      // Handled here, so the assistant panel around a chat chart stays open.
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      button.current?.focus();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      stepFocus(event.currentTarget, event.key === "ArrowDown" ? 1 : -1);
    }
  };
  const onBlur = (event: FocusEvent<HTMLElement>): void => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  };

  return (
    // Not a <dialog>: forms are modal dialogs, and this must not trap the page.
    <div
      data-no-export=""
      className="relative flex justify-end"
      onKeyDown={onKeyDown}
      onBlur={onBlur}
    >
      <button
        ref={button}
        type="button"
        className="quiet-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen(!open)}
      >
        Export <span aria-hidden>▾</span>
      </button>
      {failed && (
        <p role="alert" className="absolute right-0 top-full text-xs text-loss">
          Could not export this chart.
        </p>
      )}
      {open && <ExportItems id={menuId} title={title} onPick={run} />}
    </div>
  );
};

/** Wraps every chart that has data: its children (the chart and its own legend) plus the Export menu. */
export const ChartFrame = ({
  title,
  className,
  children,
}: {
  /** Names the file and heads the picture; the page's own heading for this chart. */
  readonly title: string;
  readonly className?: string;
  readonly children: ReactNode;
}) => {
  const frame = useRef<HTMLDivElement>(null);
  return (
    <div ref={frame} data-chart-frame="" className={className}>
      <ExportMenu title={title} frameRef={frame} />
      {children}
    </div>
  );
};

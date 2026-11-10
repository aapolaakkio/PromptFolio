import {
  useCallback,
  useEffect,
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
import { menuStep } from "./menu-keys.ts";

type Export = (frame: HTMLElement, title: string) => void | Promise<void>;
/** Closed, or open with focus entering at that end. */
type Opened = "first" | "last" | null;

const savePng: Export = async (frame, title) => {
  const blob = await chartToPng(frame, { title });
  downloadBlob(blob, exportFileName(title, "png", new Date()));
};

const savePdf: Export = (frame, title) =>
  printChart(frame, { title, today: new Date(), win: window, doc: document });

const FORMATS: readonly { readonly label: string; readonly run: Export }[] = [
  { label: "PNG", run: savePng },
  { label: "PDF", run: savePdf },
];

const itemsOf = (within: Element): HTMLElement[] =>
  Array.from(within.querySelectorAll<HTMLElement>('[role="menuitem"]'));

/** Moves focus as a menu's keyboard pattern expects; false when the key is not a menu key. */
const moveFocus = (menu: Element, key: string): boolean => {
  const items = itemsOf(menu);
  const current = items.findIndex((item) => item === document.activeElement);
  const next = menuStep(key, current, items.length);
  if (next === null) return false;
  items[next]?.focus();
  return true;
};

const ExportItems = ({
  id,
  title,
  enter,
  onPick,
}: {
  readonly id: string;
  readonly title: string;
  readonly enter: "first" | "last";
  readonly onPick: (action: Export) => void;
}) => {
  const menu = useRef<HTMLDivElement>(null);
  // Focus goes into the menu as it opens, so arrows and blur work from the first keypress.
  useEffect(() => {
    if (menu.current !== null)
      itemsOf(menu.current)
        .at(enter === "first" ? 0 : -1)
        ?.focus();
  }, [enter]);
  return (
    <div
      ref={menu}
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
};

/** Open state and every way of closing: Escape, focus leaving, and a press outside (a mouse click does not focus a button in Safari, so blur alone misses it). */
const useMenu = (button: RefObject<HTMLButtonElement | null>) => {
  const [opened, setOpened] = useState<Opened>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpened(null), []);
  const open = opened !== null;

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && wrapper.current?.contains(event.target) !== true) close();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, close]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (!open) {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      setOpened(event.key === "ArrowUp" ? "last" : "first");
    } else if (event.key === "Escape") {
      // Handled here, so the assistant panel around a chat chart stays open.
      event.preventDefault();
      event.stopPropagation();
      close();
      button.current?.focus();
    } else if (moveFocus(event.currentTarget, event.key)) {
      event.preventDefault();
    }
  };
  const onBlur = (event: FocusEvent<HTMLElement>): void => {
    if (!event.currentTarget.contains(event.relatedTarget)) close();
  };
  const toggle = (): void => setOpened(open ? null : "first");
  return { opened, wrapper, close, toggle, onKeyDown, onBlur };
};

/** Runs one export for the frame and remembers whether it failed. */
const useExport = (frameRef: RefObject<HTMLElement | null>, title: string) => {
  const [failed, setFailed] = useState(false);
  const run = (action: Export): void => {
    setFailed(false);
    const frame = frameRef.current;
    if (frame === null) return;
    Promise.resolve()
      .then(() => action(frame, title))
      .catch((error) => {
        console.error(`Chart export failed: ${title}`, error);
        setFailed(true);
      });
  };
  return { failed, run };
};

const ExportMenu = ({
  title,
  frameRef,
}: {
  readonly title: string;
  readonly frameRef: RefObject<HTMLElement | null>;
}) => {
  const button = useRef<HTMLButtonElement>(null);
  const menu = useMenu(button);
  const exporting = useExport(frameRef, title);
  const menuId = useId();
  const pick = (action: Export): void => {
    // Before the entry unmounts: focus dropped on <body> would leave the assistant panel.
    button.current?.focus();
    menu.close();
    exporting.run(action);
  };

  return (
    // Not a <dialog>: forms are modal dialogs, and this must not trap the page.
    <div
      ref={menu.wrapper}
      data-no-export=""
      className="relative flex justify-end"
      onKeyDown={menu.onKeyDown}
      onBlur={menu.onBlur}
    >
      <button
        ref={button}
        type="button"
        className="quiet-button"
        aria-haspopup="menu"
        aria-expanded={menu.opened !== null}
        aria-controls={menu.opened === null ? undefined : menuId}
        onClick={menu.toggle}
      >
        Export <span aria-hidden>▾</span>
      </button>
      {exporting.failed && menu.opened === null && (
        <p role="alert" className="absolute right-0 top-full text-xs text-loss">
          Could not export this chart.
        </p>
      )}
      {menu.opened !== null && (
        <ExportItems id={menuId} title={title} enter={menu.opened} onPick={pick} />
      )}
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

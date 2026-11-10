import {
  useEffect,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from "react";

import {
  CLOSED_PANEL,
  isShortcut,
  NARROW_QUERY,
  PANEL_STEP,
  panelReducer,
  readPanel,
  type PanelAction,
} from "./assistant-state.ts";
import { readStoredPanel, storePanel } from "./assistant-storage.ts";

// The window the panel is fixed to, without its scrollbar.
const viewport = (): number => document.documentElement.clientWidth;

/**
 * The panel state, restored after mount (the server renders it closed). Transitions start a frame
 * after the restore, so a panel stored open appears in place instead of sliding in on every load.
 */
export const usePanelState = () => {
  const [state, dispatch] = useReducer(panelReducer, CLOSED_PANEL);
  const [animate, setAnimate] = useState(false);
  // Zero on the server; the handle's aria-valuemax needs the real window.
  const [width, setWidth] = useState(0);
  const restored = useRef(false);

  useEffect(() => {
    dispatch({ type: "restore", state: readPanel(readStoredPanel()) });
    dispatch({ type: "fit", viewport: viewport() });
    setWidth(viewport());
    const frame = requestAnimationFrame(() => setAnimate(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    // The first run sees the default, not the stored state; writing it would erase what is stored.
    if (!restored.current) {
      restored.current = true;
      return;
    }
    storePanel(JSON.stringify(state));
  }, [state]);

  useEffect(() => {
    const fit = () => {
      dispatch({ type: "fit", viewport: viewport() });
      setWidth(viewport());
    };
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  return { state, dispatch, animate, viewportWidth: width };
};

/** Under the breakpoint the panel is a full-width overlay: no resize handle, and the page behind it is inert. */
export const useNarrow = (): boolean => {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const media = matchMedia(NARROW_QUERY);
    const apply = () => setNarrow(media.matches);
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);
  return narrow;
};

/** Follows the sticky header's height, so the panel starts right under it on any width. */
export const useHeight = () => {
  const ref = useRef<HTMLElement>(null);
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const observer = new ResizeObserver(() => setHeight(element.offsetHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, height };
};

const isTyping = (target: EventTarget | null): target is HTMLElement =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

/** Ctrl/Cmd+K toggles, except while typing in a field outside the panel, and not on the Chat page. */
export const useShortcut = (
  enabled: boolean,
  panel: RefObject<HTMLElement | null>,
  toggle: () => void,
) => {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      const inside = event.target instanceof Node && panel.current?.contains(event.target);
      if (!isShortcut(event, isTyping(event.target) && inside !== true)) return;
      event.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, panel, toggle]);
};

/** Focus goes to the composer when the owner opens the panel and back to the toggle when they close it; a restore moves nothing. */
export const useFocusOnToggle = (
  shown: boolean,
  byOwner: RefObject<boolean>,
  composer: RefObject<HTMLTextAreaElement | null>,
  toggle: RefObject<HTMLButtonElement | null>,
) => {
  const wasShown = useRef(false);
  useEffect(() => {
    if (shown === wasShown.current) return;
    wasShown.current = shown;
    const owner = byOwner.current;
    byOwner.current = false;
    if (!owner) return;
    if (shown) composer.current?.focus({ preventScroll: true });
    else toggle.current?.focus();
  }, [shown, byOwner, composer, toggle]);
};

// The handle is the panel's left edge: left makes it wider.
const keyAction = (key: string, width: number): PanelAction | null => {
  switch (key) {
    case "ArrowLeft":
      return { type: "step", delta: PANEL_STEP, viewport: width };
    case "ArrowRight":
      return { type: "step", delta: -PANEL_STEP, viewport: width };
    case "Home":
      return { type: "edge", to: "min", viewport: width };
    case "End":
      return { type: "edge", to: "max", viewport: width };
    default:
      return null;
  }
};

/** The left-edge handle: pointer capture keeps the drag on the handle; widths land once per frame. */
export const useWidthDrag = (dispatch: (action: PanelAction) => void) => {
  const [dragging, setDragging] = useState(false);
  const frame = useRef(0);
  const latest = useRef(0);

  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };
  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    latest.current = viewport() - event.clientX;
    if (frame.current !== 0) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      dispatch({ type: "resize", width: latest.current, viewport: viewport() });
    });
  };
  const stop = () => setDragging(false);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const action = keyAction(event.key, viewport());
    if (action === null) return;
    event.preventDefault();
    dispatch(action);
  };
  const handlers = {
    onPointerDown,
    onPointerMove,
    onPointerUp: stop,
    onPointerCancel: stop,
    onLostPointerCapture: stop,
    onKeyDown,
    onDoubleClick: () => dispatch({ type: "reset" }),
  };
  return { dragging, handlers };
};

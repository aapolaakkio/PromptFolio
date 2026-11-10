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

/** The panel state, restored after mount; it slides only once the restore is on screen. */
export const usePanelState = () => {
  const [state, dispatch] = useReducer(panelReducer, CLOSED_PANEL);
  const [restored, setRestored] = useState(false);
  const [animate, setAnimate] = useState(false);
  // Zero on the server; the panel clamps its stored width to the real window when drawn.
  const [width, setWidth] = useState(0);

  useEffect(() => {
    dispatch({ type: "restore", state: readPanel(readStoredPanel()) });
    setWidth(viewport());
    setRestored(true);
  }, []);

  useEffect(() => {
    // Runs after the restored state has committed, so a panel stored open never slides in on load.
    if (!restored) return;
    const frame = requestAnimationFrame(() => setAnimate(true));
    return () => cancelAnimationFrame(frame);
  }, [restored]);

  useEffect(() => {
    // Before the restore this would be the default, and writing it would erase what is stored.
    if (restored) storePanel(JSON.stringify(state));
  }, [restored, state]);

  useEffect(() => {
    const measure = () => setWidth(viewport());
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  return { state, dispatch, animate, viewportWidth: width };
};

/** Under the breakpoint the panel is a full-width overlay over an inert page. */
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

/** Owner open focuses the composer, owner close the toggle; a restore moves nothing. */
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

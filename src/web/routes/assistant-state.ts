import { z } from "zod";

import { ASSISTANT_PAGES, type AssistantPage } from "../../server/chat/page-context.ts";

/** The docked assistant: lives above the router outlet and in localStorage, so it survives navigation and reloads. */
export type PanelState = {
  readonly open: boolean;
  readonly conversationId: number | null;
  /** The owner's chosen width; clamped only when drawn, so a small window never overwrites it. */
  readonly width: number;
};

export const PANEL_MIN_WIDTH = 320;
export const PANEL_DEFAULT_WIDTH = 400;
/** The panel never takes more than this share of the window, so the page keeps most of it. */
export const PANEL_MAX_SHARE = 0.6;
/** One arrow-key press on the resize handle. */
export const PANEL_STEP = 16;
// A stored width past any real screen is not something the app wrote.
const STORED_MAX_WIDTH = 10_000;

/** Below this width the panel is a full-width overlay with no resize handle. */
export const NARROW_MAX_PX = 899;
export const NARROW_QUERY = `(max-width: ${NARROW_MAX_PX}px)`;

export const clampWidth = (width: number, viewport: number): number =>
  Math.round(Math.max(PANEL_MIN_WIDTH, Math.min(width, viewport * PANEL_MAX_SHARE)));

export type PanelAction =
  | { readonly type: "toggle" }
  | { readonly type: "open" }
  | { readonly type: "close" }
  | { readonly type: "conversation"; readonly id: number | null }
  | { readonly type: "restore"; readonly state: PanelState }
  | { readonly type: "resize"; readonly width: number; readonly viewport: number }
  | { readonly type: "step"; readonly delta: number; readonly viewport: number }
  | { readonly type: "edge"; readonly to: "min" | "max"; readonly viewport: number }
  | { readonly type: "reset" };

export const CLOSED_PANEL: PanelState = {
  open: false,
  conversationId: null,
  width: PANEL_DEFAULT_WIDTH,
};

export const PANEL_KEY = "assistant-panel";

const withWidth = (state: PanelState, width: number): PanelState =>
  width === state.width ? state : { ...state, width };

const resized = (state: PanelState, action: PanelAction): PanelState => {
  switch (action.type) {
    case "resize":
      return withWidth(state, clampWidth(action.width, action.viewport));
    case "step":
      // From the width shown, which a small window may have clamped below the stored one.
      return withWidth(
        state,
        clampWidth(clampWidth(state.width, action.viewport) + action.delta, action.viewport),
      );
    case "edge":
      return withWidth(
        state,
        clampWidth(action.to === "min" ? 0 : Number.POSITIVE_INFINITY, action.viewport),
      );
    case "reset":
      return withWidth(state, PANEL_DEFAULT_WIDTH);
    default:
      return state;
  }
};

export const panelReducer = (state: PanelState, action: PanelAction): PanelState => {
  switch (action.type) {
    case "toggle":
      return { ...state, open: !state.open };
    case "open":
      return { ...state, open: true };
    case "close":
      return { ...state, open: false };
    case "conversation":
      return { ...state, conversationId: action.id };
    case "restore":
      return action.state;
    default:
      return resized(state, action);
  }
};

const StoredPanel = z.object({
  open: z.boolean(),
  conversationId: z.number().int().positive().nullable(),
  width: z.number().int().min(PANEL_MIN_WIDTH).max(STORED_MAX_WIDTH).default(PANEL_DEFAULT_WIDTH),
});

/** Whatever localStorage holds is checked like any other input; anything off starts closed. */
export const readPanel = (raw: string | null): PanelState => {
  if (raw === null) return CLOSED_PANEL;
  try {
    const parsed = StoredPanel.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : CLOSED_PANEL;
  } catch {
    return CLOSED_PANEL;
  }
};

/** How close to the end still counts as "reading the latest", so a rounding pixel does not stop the follow. */
const FOLLOW_SLACK_PX = 24;

/** The transcript follows new text only while the reader is at the bottom. */
export const isNearBottom = (box: {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}): boolean => box.scrollHeight - box.scrollTop - box.clientHeight <= FOLLOW_SLACK_PX;

const isPage = (name: string): name is AssistantPage =>
  ASSISTANT_PAGES.some((page) => page === name);

/** The page the app tells the server about, from the route; never from anything the model said. */
export const pageOf = (pathname: string): AssistantPage | null => {
  const name = pathname.replace(/^\/+|\/+$/g, "");
  if (name === "") return "dashboard";
  return isPage(name) && name !== "dashboard" ? name : null;
};

/** On the full Chat page the page itself is the chat, so the dock and its toggle step aside. */
export const dockShown = (state: PanelState, pathname: string): boolean =>
  state.open && pageOf(pathname) !== "chat";

type Chord = {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
};

/** Ctrl/Cmd+K, except while the owner types in a field outside the panel. */
export const isShortcut = (chord: Chord, typingElsewhere: boolean): boolean =>
  !typingElsewhere &&
  chord.key.toLowerCase() === "k" &&
  (chord.ctrlKey || chord.metaKey) &&
  !chord.altKey &&
  !chord.shiftKey;

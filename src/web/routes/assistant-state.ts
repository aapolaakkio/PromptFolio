import { z } from "zod";

import { ASSISTANT_PAGES, type AssistantPage } from "../../server/chat/page-context.ts";

/** The docked assistant: lives above the router outlet and in localStorage, so it survives navigation and reloads. */
export type PanelState = { readonly open: boolean; readonly conversationId: number | null };

export type PanelAction =
  | { readonly type: "toggle" }
  | { readonly type: "open" }
  | { readonly type: "close" }
  | { readonly type: "conversation"; readonly id: number | null }
  | { readonly type: "restore"; readonly state: PanelState };

export const CLOSED_PANEL: PanelState = { open: false, conversationId: null };

export const PANEL_KEY = "assistant-panel";

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
  }
};

const StoredPanel = z.object({
  open: z.boolean(),
  conversationId: z.number().int().positive().nullable(),
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

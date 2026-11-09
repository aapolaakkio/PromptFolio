import { describe, expect, test } from "vitest";

import {
  CLOSED_PANEL,
  dockShown,
  isShortcut,
  pageOf,
  panelReducer,
  readPanel,
} from "./assistant-state.ts";

const key = (overrides: Partial<Parameters<typeof isShortcut>[0]> = {}) => ({
  key: "k",
  ctrlKey: false,
  metaKey: true,
  altKey: false,
  shiftKey: false,
  ...overrides,
});

describe("panelReducer", () => {
  test("opens, closes and toggles without touching the conversation", () => {
    const chosen = panelReducer(CLOSED_PANEL, { type: "conversation", id: 7 });
    const opened = panelReducer(chosen, { type: "toggle" });
    expect(opened).toEqual({ open: true, conversationId: 7 });
    expect(panelReducer(opened, { type: "toggle" })).toEqual({ open: false, conversationId: 7 });
    expect(panelReducer(opened, { type: "close" })).toEqual({ open: false, conversationId: 7 });
    expect(panelReducer(chosen, { type: "open" })).toEqual({ open: true, conversationId: 7 });
  });

  test("a new conversation clears the id and keeps the panel open", () => {
    const open = { open: true, conversationId: 7 };
    expect(panelReducer(open, { type: "conversation", id: null })).toEqual({
      open: true,
      conversationId: null,
    });
  });

  test("the conversation survives a route change: only the dock's visibility follows the path", () => {
    const state = { open: true, conversationId: 7 };
    expect(dockShown(state, "/cash")).toBe(true);
    // On the full Chat page the page itself is the chat.
    expect(dockShown(state, "/chat")).toBe(false);
    expect(dockShown(state, "/holdings")).toBe(true);
    expect(state).toEqual({ open: true, conversationId: 7 });
    expect(dockShown({ open: false, conversationId: 7 }, "/cash")).toBe(false);
  });

  test("restores what was stored, and falls back to closed on anything else", () => {
    expect(readPanel('{"open":true,"conversationId":3}')).toEqual({
      open: true,
      conversationId: 3,
    });
    expect(readPanel(null)).toEqual(CLOSED_PANEL);
    expect(readPanel("not json")).toEqual(CLOSED_PANEL);
    expect(readPanel('{"open":"yes","conversationId":-1}')).toEqual(CLOSED_PANEL);
  });
});

describe("pageOf", () => {
  test("maps each route to its page, and an unknown path to none", () => {
    expect(pageOf("/")).toBe("dashboard");
    expect(pageOf("/holdings")).toBe("holdings");
    expect(pageOf("/imports/")).toBe("imports");
    expect(pageOf("/chat")).toBe("chat");
    expect(pageOf("/settings")).toBeNull();
  });
});

describe("isShortcut", () => {
  test("Cmd+K or Ctrl+K toggles, other chords do not", () => {
    expect(isShortcut(key(), false)).toBe(true);
    expect(isShortcut(key({ metaKey: false, ctrlKey: true, key: "K" }), false)).toBe(true);
    expect(isShortcut(key({ metaKey: false }), false)).toBe(false);
    expect(isShortcut(key({ shiftKey: true }), false)).toBe(false);
    expect(isShortcut(key({ key: "j" }), false)).toBe(false);
  });

  test("is left alone while the owner types in a field outside the panel", () => {
    expect(isShortcut(key(), true)).toBe(false);
  });
});

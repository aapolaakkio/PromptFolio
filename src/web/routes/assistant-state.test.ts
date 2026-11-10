import { describe, expect, test } from "vitest";

import { ASSISTANT_PAGES } from "../../server/chat/page-context.ts";
import {
  CLOSED_PANEL,
  clampWidth,
  dockShown,
  isNearBottom,
  isShortcut,
  pageOf,
  PANEL_DEFAULT_WIDTH,
  PANEL_MIN_WIDTH,
  PANEL_STEP,
  panelReducer,
  readPanel,
} from "./assistant-state.ts";
import { STARTERS } from "./starters.ts";

const W = PANEL_DEFAULT_WIDTH;

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
    expect(opened).toEqual({ open: true, conversationId: 7, width: W });
    expect(panelReducer(opened, { type: "toggle" })).toEqual({ ...opened, open: false });
    expect(panelReducer(opened, { type: "close" })).toEqual({ ...opened, open: false });
    expect(panelReducer(chosen, { type: "open" })).toEqual(opened);
  });

  test("a new conversation clears the id and keeps the panel open", () => {
    const open = { open: true, conversationId: 7, width: W };
    expect(panelReducer(open, { type: "conversation", id: null })).toEqual({
      ...open,
      conversationId: null,
    });
  });

  test("the conversation survives a route change: only the dock's visibility follows the path", () => {
    const state = { open: true, conversationId: 7, width: W };
    expect(dockShown(state, "/cash")).toBe(true);
    // On the full Chat page the page itself is the chat.
    expect(dockShown(state, "/chat")).toBe(false);
    expect(dockShown(state, "/holdings")).toBe(true);
    expect(state).toEqual({ open: true, conversationId: 7, width: W });
    expect(dockShown({ ...state, open: false }, "/cash")).toBe(false);
  });

  test("restores what was stored, and falls back to closed on anything else", () => {
    expect(readPanel('{"open":true,"conversationId":3,"width":500}')).toEqual({
      open: true,
      conversationId: 3,
      width: 500,
    });
    // Stored before the panel could be resized.
    expect(readPanel('{"open":true,"conversationId":3}')).toEqual({
      open: true,
      conversationId: 3,
      width: W,
    });
    expect(readPanel('{"open":true,"conversationId":3,"width":12}')).toEqual(CLOSED_PANEL);
    expect(readPanel('{"open":true,"conversationId":3,"width":"wide"}')).toEqual(CLOSED_PANEL);
    expect(readPanel(null)).toEqual(CLOSED_PANEL);
    expect(readPanel("not json")).toEqual(CLOSED_PANEL);
    expect(readPanel('{"open":"yes","conversationId":-1}')).toEqual(CLOSED_PANEL);
  });
});

describe("panel width", () => {
  test("is clamped between the minimum and a share of the viewport", () => {
    expect(clampWidth(100, 1600)).toBe(PANEL_MIN_WIDTH);
    expect(clampWidth(500, 1600)).toBe(500);
    expect(clampWidth(5000, 1600)).toBe(960);
    // A viewport too small for the share still gets the minimum.
    expect(clampWidth(500, 400)).toBe(PANEL_MIN_WIDTH);
  });

  test("drag, arrow steps, Home/End and reset all stay inside the clamp", () => {
    const state = { ...CLOSED_PANEL, open: true };
    expect(panelReducer(state, { type: "resize", width: 700, viewport: 1600 }).width).toBe(700);
    expect(panelReducer(state, { type: "resize", width: 9000, viewport: 1600 }).width).toBe(960);
    expect(panelReducer(state, { type: "step", delta: PANEL_STEP, viewport: 1600 }).width).toBe(
      W + PANEL_STEP,
    );
    const narrowest = { ...state, width: PANEL_MIN_WIDTH };
    expect(
      panelReducer(narrowest, { type: "step", delta: -PANEL_STEP, viewport: 1600 }).width,
    ).toBe(PANEL_MIN_WIDTH);
    expect(panelReducer(state, { type: "edge", to: "max", viewport: 1600 }).width).toBe(960);
    expect(panelReducer(state, { type: "edge", to: "min", viewport: 1600 }).width).toBe(
      PANEL_MIN_WIDTH,
    );
    expect(panelReducer({ ...state, width: 800 }, { type: "reset" }).width).toBe(W);
  });

  test("a smaller window re-clamps a stored width", () => {
    const wide = { ...CLOSED_PANEL, width: 900 };
    expect(panelReducer(wide, { type: "fit", viewport: 1000 }).width).toBe(600);
    expect(panelReducer(wide, { type: "fit", viewport: 2000 })).toBe(wide);
  });
});

describe("isNearBottom", () => {
  test("follows only while the reader is at, or a few pixels from, the bottom", () => {
    expect(isNearBottom({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 })).toBe(true);
    expect(isNearBottom({ scrollTop: 590, scrollHeight: 1000, clientHeight: 400 })).toBe(true);
    expect(isNearBottom({ scrollTop: 300, scrollHeight: 1000, clientHeight: 400 })).toBe(false);
    // Nothing to scroll yet.
    expect(isNearBottom({ scrollTop: 0, scrollHeight: 200, clientHeight: 400 })).toBe(true);
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

describe("STARTERS", () => {
  test("every page of the page enum has two or three starter questions", () => {
    for (const page of ASSISTANT_PAGES) {
      const questions = STARTERS[page];
      expect(questions.length, page).toBeGreaterThanOrEqual(2);
      expect(questions.length, page).toBeLessThanOrEqual(3);
    }
  });
});

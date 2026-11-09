import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { AssistantContext, SelectionContext, type Selection } from "./assistant-context.ts";
import {
  CLOSED_PANEL,
  dockShown,
  isShortcut,
  PANEL_KEY,
  pageOf,
  panelReducer,
  readPanel,
  type PanelAction,
} from "./assistant-state.ts";
import { ChatPanel } from "./ChatPanel.tsx";

const PANEL_ID = "assistant-panel";

// Private windows and blocked storage throw; the panel then just forgets between loads.
const readStorage = (): string | null => {
  try {
    return localStorage.getItem(PANEL_KEY);
  } catch {
    return null;
  }
};
const writeStorage = (value: string): void => {
  try {
    localStorage.setItem(PANEL_KEY, value);
  } catch {
    // Nothing to keep it in; the open panel still works for this load.
  }
};

const isTyping = (target: EventTarget | null): target is HTMLElement =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

/** Follows the sticky header's height, so the dock starts right under it on any width. */
const useHeight = () => {
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

type AssistantLayoutProps = { readonly start: ReactNode; readonly end: ReactNode };

/**
 * The authenticated shell with the assistant docked beside every page. Its state sits above the
 * outlet, so a conversation (and an answer still streaming) survives a change of page. Closed on
 * the server and on first paint; the stored state opens it after mount.
 */
export const AssistantLayout = ({ start, end }: AssistantLayoutProps) => {
  const pathname = useRouterState({ select: (router) => router.location.pathname });
  const [state, dispatch] = useReducer(panelReducer, CLOSED_PANEL);
  const [selection, setSelection] = useState<Selection | undefined>(undefined);
  // Once opened the panel stays mounted (hidden when closed), so a stream is never cut off.
  const [kept, setKept] = useState(false);
  const header = useHeight();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const composerRef = useRef<HTMLInputElement>(null);
  const dockRef = useRef<HTMLElement>(null);
  const restored = useRef(false);
  // Focus moves only when the owner opened or closed it, not when a reload restored it.
  const byOwner = useRef(false);
  const wasShown = useRef(false);

  const shown = dockShown(state, pathname);
  const page = pageOf(pathname);
  const onChatPage = page === "chat";

  const act = useCallback((action: PanelAction) => {
    byOwner.current = true;
    dispatch(action);
  }, []);

  useEffect(() => {
    dispatch({ type: "restore", state: readPanel(readStorage()) });
  }, []);

  useEffect(() => {
    // The first run sees the default, not the stored state; writing it would erase what is stored.
    if (!restored.current) {
      restored.current = true;
      return;
    }
    writeStorage(JSON.stringify(state));
  }, [state]);

  useEffect(() => {
    if (shown) setKept(true);
    if (shown === wasShown.current) return;
    wasShown.current = shown;
    const owner = byOwner.current;
    byOwner.current = false;
    if (!owner) return;
    if (shown) composerRef.current?.focus();
    else toggleRef.current?.focus();
  }, [shown]);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (onChatPage) return;
      const inside = event.target instanceof Node && dockRef.current?.contains(event.target);
      if (!isShortcut(event, isTyping(event.target) && inside !== true)) return;
      event.preventDefault();
      act({ type: "toggle" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onChatPage, act]);

  // The handler sits on the panel, so Escape closes it only while focus is inside.
  const onPanelKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    act({ type: "close" });
  };

  const assistant = useMemo(() => ({ state, dispatch }), [state]);
  const context = page === null ? null : selection === undefined ? { page } : { page, selection };

  return (
    <AssistantContext value={assistant}>
      <SelectionContext value={setSelection}>
        <header
          ref={header.ref}
          className="sticky top-0 z-10 flex items-center gap-6 border-b border-line bg-surface px-5 py-3"
        >
          {start}
          {!onChatPage && (
            <button
              ref={toggleRef}
              type="button"
              className="quiet-button"
              aria-expanded={shown}
              aria-controls={PANEL_ID}
              aria-keyshortcuts="Control+K Meta+K"
              title="Assistant (Ctrl/Cmd+K)"
              onClick={() => act({ type: "toggle" })}
            >
              Chat
            </button>
          )}
          {end}
        </header>
        <div className={shown ? "min-[900px]:pr-[400px]" : undefined}>
          <main className="mx-auto max-w-5xl px-5 pb-16 pt-8">
            <Outlet />
          </main>
        </div>
        <aside
          id={PANEL_ID}
          ref={dockRef}
          aria-label="Assistant"
          style={{ top: header.height }}
          className={`${shown ? "flex" : "hidden"} fixed bottom-0 right-0 z-10 w-full flex-col gap-3 border-l border-line bg-surface p-4 min-[900px]:w-[400px]`}
          onKeyDown={onPanelKey}
        >
          {(shown || kept) && (
            <>
              <div className="flex items-center gap-3">
                <h2 className="mb-0 mr-auto">Assistant</h2>
                <Link to="/chat" className="text-sm">
                  Open full view
                </Link>
                <button
                  type="button"
                  className="quiet-button"
                  aria-label="Close assistant"
                  onClick={() => act({ type: "close" })}
                >
                  ×
                </button>
              </div>
              <ChatPanel
                conversationId={state.conversationId}
                onConversation={(id) => dispatch({ type: "conversation", id })}
                context={context}
                variant="dock"
                composerRef={composerRef}
              />
            </>
          )}
        </aside>
      </SelectionContext>
    </AssistantContext>
  );
};

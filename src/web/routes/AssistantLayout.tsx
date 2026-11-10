import { useQuery } from "@tanstack/react-query";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { getConversations } from "../server/chat.ts";
import { AssistantContext, SelectionContext, type Selection } from "./assistant-context.ts";
import {
  useFocusOnToggle,
  useHeight,
  useNarrow,
  usePanelState,
  useShortcut,
  useWidthDrag,
} from "./assistant-hooks.ts";
import {
  clampWidth,
  dockShown,
  pageOf,
  PANEL_MIN_WIDTH,
  type PanelAction,
  type PanelState,
} from "./assistant-state.ts";
import { ChatPanel } from "./ChatPanel.tsx";

const PANEL_ID = "assistant-panel";

/** The page's own layout; the panel lies over it and never moves it. */
export const PAGE_CLASS = "mx-auto max-w-5xl px-5 pb-16 pt-8";

/** Takes only `inert`: there is nothing here for the panel's width or open state to reach. */
export const PageContent = ({
  inert,
  children,
}: {
  readonly inert: boolean;
  readonly children: ReactNode;
}) => (
  <div inert={inert}>
    <main className={PAGE_CLASS}>{children}</main>
  </div>
);

const AssistantToggle = ({
  shown,
  answering,
  toggleRef,
  onToggle,
}: {
  readonly shown: boolean;
  readonly answering: boolean;
  readonly toggleRef: RefObject<HTMLButtonElement | null>;
  readonly onToggle: () => void;
}) => (
  <button
    ref={toggleRef}
    type="button"
    className="quiet-button inline-flex items-center gap-1.5"
    aria-expanded={shown}
    aria-controls={PANEL_ID}
    aria-keyshortcuts="Control+K Meta+K"
    title="Assistant (Ctrl/Cmd+K)"
    onClick={onToggle}
  >
    Chat
    {answering && !shown && (
      <>
        <span aria-hidden className="size-1.5 rounded-full bg-accent motion-safe:animate-pulse" />
        <span className="sr-only">, answer in progress</span>
      </>
    )}
  </button>
);

const DockHeader = ({
  conversationId,
  busy,
  onNew,
  onClose,
}: {
  readonly conversationId: number | null;
  readonly busy: boolean;
  readonly onNew: () => void;
  readonly onClose: () => void;
}) => {
  const conversations = useQuery({
    queryKey: ["conversations"],
    queryFn: () => getConversations(),
  });
  const title = conversations.data?.find((row) => row.id === conversationId)?.title ?? "Assistant";
  return (
    <div className="grid gap-2">
      <h2 className="mb-0 truncate" title={title}>
        {title}
      </h2>
      <div className="flex flex-wrap items-center gap-1">
        <button type="button" className="quiet-button" disabled={busy} onClick={onNew}>
          New conversation
        </button>
        <Link to="/chat" className="quiet-button no-underline">
          Open full view
        </Link>
        <button type="button" className="quiet-button ml-auto" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
};

const ResizeHandle = ({
  width,
  viewport,
  drag,
}: {
  readonly width: number;
  readonly viewport: number;
  readonly drag: ReturnType<typeof useWidthDrag>;
}) => (
  // A focusable separator is the ARIA pattern for a resizable splitter.
  <div
    role="separator"
    aria-orientation="vertical"
    aria-label="Resize assistant"
    aria-valuenow={width}
    aria-valuemin={PANEL_MIN_WIDTH}
    aria-valuemax={clampWidth(Number.POSITIVE_INFINITY, viewport)}
    tabIndex={0}
    className="absolute inset-y-0 left-0 w-2 -translate-x-1/2 cursor-col-resize touch-none hover:bg-line focus-visible:bg-accent"
    {...drag.handlers}
  />
);

type DockProps = {
  readonly state: PanelState;
  readonly shown: boolean;
  readonly narrow: boolean;
  readonly animate: boolean;
  readonly top: number;
  readonly viewport: number;
  readonly busy: boolean;
  readonly context: ReturnType<typeof contextOf>;
  readonly dockRef: RefObject<HTMLElement | null>;
  readonly composerRef: RefObject<HTMLTextAreaElement | null>;
  readonly act: (action: PanelAction) => void;
  readonly dispatch: (action: PanelAction) => void;
};

const dockClass = (shown: boolean, animate: boolean): string =>
  [
    "fixed bottom-0 right-0 z-10 flex w-full flex-col gap-3 border-l border-line bg-surface p-4",
    shown ? "translate-x-0" : "translate-x-full",
    // Only the slide animates: the width drag follows the pointer directly.
    animate
      ? "transition-transform duration-(--panel-duration) ease-out motion-reduce:transition-none"
      : "",
  ].join(" ");

/** Off-screen and inert while closed, but kept mounted so a stream is never cut off. */
const AssistantDock = (props: DockProps) => {
  const { state, shown, narrow, dockRef, act } = props;
  const [kept, setKept] = useState(false);
  if (shown && !kept) setKept(true);
  const drag = useWidthDrag(props.dispatch);
  // The stored width is the owner's choice; a small window only clamps what is drawn.
  const width = props.viewport === 0 ? state.width : clampWidth(state.width, props.viewport);
  // The handler sits on the panel, so Escape closes it only while focus is inside.
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    act({ type: "close" });
  };
  return (
    <>
      {/* Over the whole window while dragging: no text selection, no chart hover. Outside the panel, whose transform would contain it. */}
      {drag.dragging && <div className="fixed inset-0 z-20 cursor-col-resize select-none" />}
      <aside
        id={PANEL_ID}
        ref={dockRef}
        aria-label="Assistant"
        inert={!shown}
        style={{ top: props.top, width: narrow ? undefined : width }}
        className={dockClass(shown, props.animate)}
        onKeyDown={onKeyDown}
      >
        {!narrow && <ResizeHandle width={width} viewport={props.viewport} drag={drag} />}
        {kept && (
          <>
            <DockHeader
              conversationId={state.conversationId}
              busy={props.busy}
              onNew={() => props.dispatch({ type: "conversation", id: null })}
              onClose={() => act({ type: "close" })}
            />
            <ChatPanel context={props.context} variant="dock" composerRef={props.composerRef} />
          </>
        )}
      </aside>
    </>
  );
};

const contextOf = (pathname: string, selection: Selection | undefined) => {
  const page = pageOf(pathname);
  if (page === null) return null;
  return selection === undefined ? { page } : { page, selection };
};

/** Assistant state above the outlet, so a conversation and its stream survive a page change. */
const useAssistantShell = () => {
  const pathname = useRouterState({ select: (router) => router.location.pathname });
  const panel = usePanelState();
  const [selection, setSelection] = useState<Selection | undefined>(undefined);
  const [turnRunning, setTurnRunning] = useState(false);
  const narrow = useNarrow();
  const refs = {
    toggle: useRef<HTMLButtonElement>(null),
    composer: useRef<HTMLTextAreaElement>(null),
    dock: useRef<HTMLElement>(null),
    byOwner: useRef(false),
  };
  const shown = dockShown(panel.state, pathname);
  const onChatPage = pageOf(pathname) === "chat";
  const { dispatch } = panel;
  const byOwner = refs.byOwner;
  const act = useCallback(
    (action: PanelAction) => {
      byOwner.current = true;
      dispatch(action);
    },
    [byOwner, dispatch],
  );
  const toggle = useCallback(() => act({ type: "toggle" }), [act]);
  useShortcut(!onChatPage, refs.dock, toggle);
  useFocusOnToggle(shown, refs.byOwner, refs.composer, refs.toggle);
  const assistant = useMemo(
    () => ({ state: panel.state, dispatch, turnRunning, setTurnRunning }),
    [panel.state, dispatch, turnRunning],
  );
  const context = contextOf(pathname, selection);
  return { panel, assistant, setSelection, narrow, refs, shown, onChatPage, act, toggle, context };
};

type AssistantLayoutProps = { readonly start: ReactNode; readonly end: ReactNode };

/** The authenticated shell with the assistant available on every page. */
export const AssistantLayout = ({ start, end }: AssistantLayoutProps) => {
  const shell = useAssistantShell();
  const header = useHeight();
  return (
    <AssistantContext value={shell.assistant}>
      <SelectionContext value={shell.setSelection}>
        <header
          ref={header.ref}
          className="sticky top-0 z-10 flex items-center gap-6 border-b border-line bg-surface px-5 py-3"
        >
          {start}
          {!shell.onChatPage && (
            <AssistantToggle
              shown={shell.shown}
              answering={shell.assistant.turnRunning}
              toggleRef={shell.refs.toggle}
              onToggle={shell.toggle}
            />
          )}
          {end}
        </header>
        <PageContent inert={shell.shown && shell.narrow}>
          <Outlet />
        </PageContent>
        <AssistantDock
          state={shell.panel.state}
          shown={shell.shown}
          narrow={shell.narrow}
          animate={shell.panel.animate}
          top={header.height}
          viewport={shell.panel.viewportWidth}
          busy={shell.assistant.turnRunning}
          context={shell.context}
          dockRef={shell.refs.dock}
          composerRef={shell.refs.composer}
          act={shell.act}
          dispatch={shell.panel.dispatch}
        />
      </SelectionContext>
    </AssistantContext>
  );
};

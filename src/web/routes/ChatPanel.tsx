import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";

import { Markdown } from "../markdown/Markdown.tsx";
import { CHAT_MODELS, type ChatModel } from "../../server/chat/models.ts";
import type { PageContext } from "../../server/chat/page-context.ts";
import { readStored, StoredProposal } from "../../server/chat/proposal-schema.ts";
import { StoredChartSchema } from "../../server/chat/chart-schema.ts";
import { ChatChart } from "../charts/ChatChart.tsx";
import { isNearBottom } from "./assistant-state.ts";
import { renderItems } from "./chat-order.ts";
import { cardState, type CardOutcome } from "./proposal-actions.ts";
import { ProposalCard } from "./ProposalCard.tsx";
import { STARTERS } from "./starters.ts";
import { TOOL_LABELS } from "./tool-labels.ts";
import type { LiveCard } from "./chat-rules.ts";
import { useChatTurn, type Turn } from "./use-chat-turn.ts";

const isChatModel = (value: string): value is ChatModel =>
  CHAT_MODELS.some((model) => model.id === value);

type Item = ReturnType<typeof renderItems>[number];

type Cards = {
  readonly live: ReadonlyMap<string, LiveCard>;
  readonly outcomes: ReadonlyMap<string, CardOutcome>;
  readonly saving: ReadonlySet<string>;
  readonly decide: (proposalId: string, confirm: boolean) => Promise<void>;
};

const ChartTurn = ({ turn }: { readonly turn: Turn }) => {
  const chart = readStored(StoredChartSchema, turn.content);
  if (chart === null) return null;
  return (
    <li>
      {"expired" in chart ? (
        <div className="card max-w-[90%] grid gap-1 text-sm">
          <span className="font-semibold">{chart.spec.title}</span>
          <span className="text-muted">Chart expired — ask again.</span>
        </div>
      ) : (
        <ChatChart chart={chart} />
      )}
    </li>
  );
};

const ProposalTurn = ({ turn, cards }: { readonly turn: Turn; readonly cards: Cards }) => {
  const card = readStored(StoredProposal, turn.content);
  if (card === null) return null;
  const { proposalId, title, facts, action } = card;
  const streamed = cards.live.get(proposalId)?.proposal;
  return (
    <li>
      <ProposalCard
        action={action}
        title={title}
        facts={facts}
        note={streamed?.action === "cash_entry" ? streamed.input.note : undefined}
        state={cardState(streamed, cards.outcomes.get(proposalId))}
        outcome={cards.outcomes.get(proposalId)}
        saving={cards.saving.has(proposalId)}
        onConfirm={() => void cards.decide(proposalId, true)}
        onDismiss={() => void cards.decide(proposalId, false)}
      />
    </li>
  );
};

const TurnItem = ({ item, cards }: { readonly item: Item; readonly cards: Cards }) => {
  if (item.kind === "user") {
    return (
      <li className="justify-self-end max-w-[80%] whitespace-pre-wrap rounded border border-line px-3 py-2">
        {item.content}
      </li>
    );
  }
  if (item.kind === "text") {
    return (
      <li className="max-w-[90%] rounded bg-surface px-3 py-2">
        <Markdown text={item.content} />
      </li>
    );
  }
  if (item.turn.role === "chart") return <ChartTurn turn={item.turn} />;
  if (item.turn.role === "proposal") return <ProposalTurn turn={item.turn} cards={cards} />;
  return null;
};

const itemKey = (item: Item): string => {
  if (item.kind !== "card") return item.key;
  const chart =
    item.turn.role === "chart" ? readStored(StoredChartSchema, item.turn.content) : null;
  if (chart !== null) return `chart-${chart.chartId}`;
  const card = item.turn.role === "proposal" ? readStored(StoredProposal, item.turn.content) : null;
  return card === null ? item.key : `proposal-${card.proposalId}`;
};

/** Follows the newest text, and late-growing charts or cards, only while the reader is at the bottom. */
const useFollow = (conversationId: number | null) => {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLOListElement>(null);
  const [following, setFollowing] = useState(true);
  // Another conversation opens at its newest turn.
  const [seen, setSeen] = useState(conversationId);
  if (seen !== conversationId) {
    setSeen(conversationId);
    setFollowing(true);
  }
  useEffect(() => {
    const box = scroller.current;
    const list = content.current;
    if (!following || box === null || list === null) return;
    const toBottom = () => box.scrollTo({ top: box.scrollHeight });
    toBottom();
    const observer = new ResizeObserver(toBottom);
    observer.observe(list);
    return () => observer.disconnect();
  }, [following]);
  const onScroll = () => {
    if (scroller.current !== null) setFollowing(isNearBottom(scroller.current));
  };
  const jump = () => {
    setFollowing(true);
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  };
  return { scroller, content, following, onScroll, jump };
};

const Starters = ({
  page,
  onAsk,
}: {
  readonly page: PageContext["page"];
  readonly onAsk: (text: string) => boolean;
}) => (
  <li className="grid gap-2 text-sm">
    <span className="text-muted">Ask about your own figures, for example:</span>
    {STARTERS[page].map((question) => (
      <button
        key={question}
        type="button"
        className="justify-self-start rounded-md border border-line bg-transparent px-3 py-1.5 text-left font-normal text-ink hover:bg-bg"
        onClick={() => onAsk(question)}
      >
        {question}
      </button>
    ))}
  </li>
);

type TranscriptProps = {
  readonly items: readonly Item[];
  readonly cards: Cards;
  readonly variant: "page" | "dock";
  readonly follow: ReturnType<typeof useFollow>;
  readonly empty: ReactNode;
};

const Transcript = ({ items, cards, variant, follow, empty }: TranscriptProps) => (
  <div className={variant === "dock" ? "relative flex min-h-0 flex-1 flex-col" : "relative"}>
    <div
      ref={follow.scroller}
      onScroll={follow.onScroll}
      className={`overflow-y-auto pr-1 [scrollbar-gutter:stable] ${
        variant === "dock" ? "min-h-0 flex-1" : "max-h-[55vh]"
      }`}
    >
      <ol ref={follow.content} className="grid content-start gap-3">
        {items.length === 0 && empty}
        {items.map((item) => (
          <TurnItem key={itemKey(item)} item={item} cards={cards} />
        ))}
      </ol>
    </div>
    {!follow.following && (
      <button
        type="button"
        className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full border border-line bg-surface px-3 py-1 text-sm font-normal text-ink"
        onClick={follow.jump}
      >
        Jump to latest
      </button>
    )}
  </div>
);

// About five lines; past that the box scrolls.
const COMPOSER_MAX_PX = 160;

const fitHeight = (box: HTMLTextAreaElement | null) => {
  if (box === null) return;
  box.style.height = "auto";
  box.style.height = `${Math.min(box.scrollHeight, COMPOSER_MAX_PX)}px`;
};

/** Grows with its text; Enter sends, Shift+Enter breaks the line. Never disabled, so focus stays. */
const Composer = ({
  busy,
  onAsk,
  composerRef,
}: {
  readonly busy: boolean;
  readonly onAsk: (text: string) => boolean;
  readonly composerRef: RefObject<HTMLTextAreaElement | null>;
}) => {
  const [draft, setDraft] = useState("");
  // Safari fires compositionend before the Enter that ends an IME composition, with isComposing false.
  const composing = useRef(false);
  useEffect(() => fitHeight(composerRef.current), [draft, composerRef]);
  const submit = () => {
    if (onAsk(draft)) setDraft("");
  };
  return (
    <form
      className="flex items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <textarea
        ref={composerRef}
        rows={1}
        className="min-w-0 flex-1 resize-none overflow-y-auto rounded-md border border-line bg-surface px-3 py-2 text-base text-ink"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          setTimeout(() => {
            composing.current = false;
          }, 0);
        }}
        onKeyDown={(event) => {
          const inIme = event.nativeEvent.isComposing || composing.current;
          if (event.key !== "Enter" || event.shiftKey || inIme) return;
          event.preventDefault();
          submit();
        }}
        placeholder="E.g. what is the portfolio worth today?"
        aria-label="Question"
      />
      <button type="submit" disabled={busy || draft.trim() === ""}>
        Ask
      </button>
    </form>
  );
};

const ModelPicker = ({
  model,
  busy,
  onModel,
}: {
  readonly model: ChatModel;
  readonly busy: boolean;
  readonly onModel: (model: ChatModel) => void;
}) => (
  <label className="mb-0 text-sm text-muted">
    Model
    <select
      value={model}
      disabled={busy}
      onChange={(event) => {
        if (isChatModel(event.target.value)) onModel(event.target.value);
      }}
    >
      {CHAT_MODELS.map((option) => (
        <option key={option.id} value={option.id}>
          {option.label}
        </option>
      ))}
    </select>
  </label>
);

type ChatPanelProps = {
  /** Where the owner asks from; the server resolves its ids and writes the line the model sees. */
  readonly context: PageContext | null;
  /** "dock" fills the side panel's height; "page" keeps the full Chat page's fixed transcript height. */
  readonly variant: "page" | "dock";
  readonly composerRef?: RefObject<HTMLTextAreaElement | null>;
};

/** The one conversation UI, on the Chat page and in the dock. */
export const ChatPanel = ({ context, variant, composerRef }: ChatPanelProps) => {
  const chat = useChatTurn(context);
  const ownComposer = useRef<HTMLTextAreaElement>(null);
  const shown: Turn[] =
    chat.streaming === ""
      ? chat.turns
      : [...chat.turns, { role: "assistant", content: chat.streaming }];
  const items = renderItems(shown);
  const follow = useFollow(chat.conversationId);
  return (
    <div
      className={
        variant === "dock" ? "flex min-h-0 flex-1 flex-col gap-3" : "grid content-start gap-4"
      }
    >
      <Transcript
        items={items}
        cards={chat}
        variant={variant}
        follow={follow}
        empty={<Starters page={context?.page ?? "chat"} onAsk={chat.ask} />}
      />
      {chat.busy && chat.streaming === "" && (
        <p className="text-muted">
          {chat.tools.length === 0
            ? "Thinking…"
            : `Fetched: ${chat.tools.map((name) => TOOL_LABELS.get(name) ?? name).join(", ")}`}
        </p>
      )}
      {chat.error !== null && <p role="alert">{chat.error}</p>}
      <Composer busy={chat.busy} onAsk={chat.ask} composerRef={composerRef ?? ownComposer} />
      <ModelPicker model={chat.model} busy={chat.busy} onModel={chat.setModel} />
    </div>
  );
};

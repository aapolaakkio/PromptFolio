import type { BetaContentBlock } from "@anthropic-ai/sdk/resources/beta";

import type { ChatClient, ChatEvent, ModelReply, RunOptions, TurnParams } from "./runner.ts";
import type { SearchEvent } from "./search-schema.ts";
import { searchEventsOf, unseen, type WebSearchTurn } from "./web-search.ts";

export const ROUND_BREAK = "\n\n";

type Piece =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "block"; readonly block: BetaContentBlock };

/** A model call whose text pieces can be iterated as they arrive; ends when the reply settles. */
const withDeltas = (client: ChatClient, params: TurnParams, signal?: AbortSignal) => {
  let queue: readonly Piece[] = [];
  let settled = false;
  let wake: (() => void) | null = null;
  const notify = () => {
    const waiting = wake;
    wake = null;
    waiting?.();
  };
  const push = (piece: Piece) => {
    queue = [...queue, piece];
    notify();
  };
  const onDelta = (text: string) => push({ kind: "text", text });
  const onBlock = (block: BetaContentBlock) => push({ kind: "block", block });
  const options: RunOptions = signal ? { signal, onDelta, onBlock } : { onDelta, onBlock };
  const reply = client.run(params, options).finally(() => {
    settled = true;
    notify();
  });
  // A rejection is surfaced by `await reply` in the caller, after the deltas.
  reply.catch(() => undefined);
  const deltas = {
    async *[Symbol.asyncIterator]() {
      while (!settled || queue.length > 0) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          continue;
        }
        const batch = queue;
        queue = [];
        yield* batch;
      }
    },
  };
  return { deltas, reply };
};

type Round = {
  readonly params: TurnParams;
  readonly signal: AbortSignal | undefined;
  readonly afterWords: boolean;
  readonly search: WebSearchTurn | null;
  readonly seen: ReadonlySet<string>;
};

/** One model call: its words as deltas and its searches as they finish, then the settled reply. */
export async function* streamRound(
  client: ChatClient,
  round: Round,
): AsyncGenerator<ChatEvent, { readonly reply: ModelReply; readonly seen: ReadonlySet<string> }> {
  const { search } = round;
  let seen = round.seen;
  const report = (blocks: readonly BetaContentBlock[]): SearchEvent[] => {
    if (search === null) return [];
    const found = unseen(
      blocks.flatMap((block) => searchEventsOf(block, search)),
      seen,
    );
    seen = found.seen;
    return found.fresh;
  };
  const streamed = withDeltas(client, round.params, round.signal);
  let first = true;
  for await (const piece of streamed.deltas) {
    if (piece.kind === "block") {
      yield* report([piece.block]);
      continue;
    }
    // A new round's words start a new paragraph, as they will in the stored answer.
    if (first && round.afterWords) yield { type: "delta", text: ROUND_BREAK };
    first = false;
    yield { type: "delta", text: piece.text };
  }
  const reply = await streamed.reply;
  yield* report(reply.blocks ?? []);
  return { reply, seen };
}

import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { z } from "zod";

import { anthropicStream } from "../../src/server/chat/anthropic-stream-fixture.ts";
import { NORDNET_TABLE_RECIPE } from "../../src/server/import/recipe/broker-reference.ts";
import { TABLE_HOLDINGS_RECIPE } from "../../src/server/import/recipe/holdings-reference.ts";
import { OP_BANK_CSV_RECIPE } from "../../src/server/import/recipe/op-csv-reference.ts";
import type { Upstream, UpstreamCall } from "./upstream.ts";

type Json = z.infer<ReturnType<typeof z.json>>;

export type ClaudeRequest = {
  readonly system: string;
  readonly lastUser: string;
  readonly model: string;
};

/** Scripted Claude: replies are served in order on `api.anthropic.com/v1/messages`. */
export type Claude = {
  reply(text: string): void;
  replyWithTool(name: string, input: Json): void;
  /** A structured-output answer: the model's text is this value as JSON. */
  replyJson(value: Json): void;
  /** The recipe that reads `nordnet-sample.csv`, `op-bank-sample.csv` or a pasted holdings table (tab-separated, headed Nimi, Valuutta, Määrä, Arvo EUR). */
  replyRecipe(kind: "nordnet" | "op-csv" | "holdings-table"): void;
  /** The weekly note on the Dashboard; without this the Dashboard's call gets a 400 and the note is left out. */
  replySummary(text: string): void;
  /** Calls answered from a queue, in order. A Dashboard summary call appears only when `replySummary` queued it; the default 400 for an unqueued one is not listed. */
  readonly requests: readonly ClaudeRequest[];
  /** Replies queued and never asked for. */
  readonly pending: number;
};

export const ANTHROPIC_HOST = "api.anthropic.com";
export const YAHOO_HOSTS = [
  "query1.finance.yahoo.com",
  "query2.finance.yahoo.com",
  "finance.yahoo.com",
  "fc.yahoo.com",
] as const;

const RECIPES = {
  nordnet: NORDNET_TABLE_RECIPE,
  "op-csv": OP_BANK_CSV_RECIPE,
  "holdings-table": TABLE_HOLDINGS_RECIPE,
} as const;

const SUMMARY_MARKER = "weekly note about their portfolio";
// 400 is not retried by the SDK; `x-should-retry` stops the retry of the 500 as well.
const NO_RETRY = { "x-should-retry": "false" };

const Block = z.looseObject({ type: z.string(), text: z.string().optional() });
type Block = z.infer<typeof Block>;
// A bare string and a list of blocks are two spellings of the same content.
const Content = z.union([
  z.string().transform((text): Block[] => [{ type: "text", text }]),
  z.array(Block),
]);
const Body = z.looseObject({
  model: z.string().default(""),
  system: Content.default([]),
  messages: z.array(z.looseObject({ role: z.string(), content: Content })).default([]),
});

const textOf = (content: readonly Block[]): string =>
  content.map((block) => block.text ?? JSON.stringify(block)).join("\n");

const describe = (call: UpstreamCall): ClaudeRequest => {
  const body = Body.parse(JSON.parse(call.body));
  const lastUser = body.messages.findLast((message) => message.role === "user");
  return {
    model: body.model,
    system: textOf(body.system),
    lastUser: lastUser === undefined ? "" : textOf(lastUser.content),
  };
};

const NOT_FOUND = (): Response => new Response("e2e: no stand-in chart", { status: 404 });

/** Claude, plus the 404 that Yahoo gives until a test registers a chart with `upstream.on`. Call after `upstream.reset()`. */
export const installClaude = (upstream: Upstream): Claude => {
  // Mutated in place: the handler outlives each call that fills or drains them.
  const queue: Response[] = [];
  const summaries: Response[] = [];
  const requests: ClaudeRequest[] = [];

  const stream = (text: string): Response => anthropicStream(text);
  const jsonStream = (value: Json): Response => stream(JSON.stringify(value));

  upstream.on(ANTHROPIC_HOST, (call) => {
    if (!call.path.startsWith("/v1/messages")) return undefined;
    const request = describe(call);
    const isSummary = request.system.includes(SUMMARY_MARKER);
    const next = (isSummary ? summaries : queue).shift();
    if (isSummary && next === undefined) {
      return new Response(
        JSON.stringify({
          type: "error",
          error: { type: "invalid_request_error", message: "e2e: no summary queued" },
        }),
        {
          status: 400,
          headers: { "content-type": "application/json" },
        },
      );
    }
    if (next === undefined) {
      upstream.flag(
        `POST ${ANTHROPIC_HOST}${call.path}: no reply queued (${request.lastUser.slice(0, 60)})`,
      );
      return new Response("e2e: no reply queued", { status: 500, headers: NO_RETRY });
    }
    requests.push(request);
    return next;
  });
  for (const host of YAHOO_HOSTS) upstream.on(host, NOT_FOUND);

  return {
    reply: (text) => void queue.push(stream(text)),
    replyWithTool: (name, input) =>
      void queue.push(anthropicStream("", [{ id: `toolu_${queue.length + 1}`, name, input }])),
    replyJson: (value) => void queue.push(jsonStream(value)),
    replyRecipe: (kind) => void queue.push(jsonStream(RECIPES[kind])),
    replySummary: (text) => void summaries.push(jsonStream({ text })),
    requests,
    get pending() {
      return queue.length + summaries.length;
    },
  };
};

const QUIET_MS = 200;

/**
 * End of a test: closes the page, then waits until no call has reached the upstream for a moment, so a chat turn still in flight cannot reach the next test's handler and take its reply. (No generation counter: a call carries nothing that says which test made it.) Then fails on replies left in the queue.
 */
export const finishClaude = async (
  claude: Claude,
  upstream: Upstream,
  page: Page,
): Promise<void> => {
  await page.close();
  let seen = -1;
  while (seen !== upstream.calls.length) {
    seen = upstream.calls.length;
    await new Promise((done) => setTimeout(done, QUIET_MS));
  }
  expect(claude.pending, "replies the test queued and the app never asked for").toBe(0);
};

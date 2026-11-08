import Anthropic from "@anthropic-ai/sdk";
import { transformJSONSchema } from "@anthropic-ai/sdk/lib/transform-json-schema";
import type {
  BetaContentBlock,
  BetaMessage,
  BetaMessageParam,
  BetaTool,
} from "@anthropic-ai/sdk/resources/beta";
import { env } from "cloudflare:workers";
import { z } from "zod";

import { HttpError } from "../errors.ts";
import type { JSONSchema } from "zod/v4/core";

import { DEFAULT_CHAT_MODEL } from "./models.ts";
import type { ChatTool } from "./tools.ts";

/** Thinking counts against this too, so it is roomier than an answer needs. */
const MAX_TOKENS = 16000;
/** Tool rounds in one turn. A model still calling tools past this is circling, not working. */
const MAX_ROUNDS = 10;

/**
 * What the assistant is allowed to be. The rules are not politeness: a
 * portfolio answer that invents a number is worse than no answer, so the model
 * is told in the strongest terms available that arithmetic is the tools' job.
 * Everything it says about money must trace back to a tool result -- and when
 * the tools cannot answer, saying so is the correct answer.
 */
export const SYSTEM_PROMPT = `Olet PromptFolio-sovelluksen sijoitus- ja talousavustaja. Vastaat suomeksi.

Käytettävissäsi on työkaluja, jotka lukevat käyttäjän oman salkun ja pankkitilien tapahtumista lasketut luvut. Säännöt:

1. Perusluvut tulevat aina työkaluista, eivät muistista tai arvauksesta. Jos työkalu ei anna lukua, sano ettei sitä ole saatavilla.
2. Saat johtaa uusia lukuja (erotuksia, osuuksia, keskiarvoja, kuukausitasoja). Käytä siihen calculate-työkalua äläkä laske päässäsi: sentin virhe omassa taloudessa on virhe, ei pyöristys. Kerro lyhyesti mistä johdettu luku muodostuu.
3. Kerro aina mihin päivään luvut perustuvat (työkalun 'asOf'). Jos työkalu palauttaa 'stale': true, kerro että osa hinnoista on vanhentuneita.
4. Jos työkalu palauttaa null tai kertoo ettei lukua voi laskea, sano se suoraan.
5. Kulujen luokittelu perustuu sääntöihin, jotka eivät tunne kaikkia kauppoja. Tuntemattomat näkyvät luokassa Muu. Saat tallentaa sääntöjä save_spending_rules-työkalulla, korjata väärän luokan update_spending_rule-työkalulla ja poistaa liian laajan säännön remove_spending_rule-työkalulla. Nämä ovat ainoat työkalut jotka kirjoittavat, ja ne kirjoittavat vain luokittelun -- eivät koskaan tapahtumia. Säännöt: tallenna vain nimiä jotka näit työkalun tuloksissa, älä keksi maksunsaajia, kerro aina mitä tallensit tai muutit, ja jos työkalu kertoo säännön kuuluvan käyttäjälle, sano että sen voi muuttaa Kulutus-sivulla. Ennen kuin tallennat kerralla useita, kerro mitä aiot tallentaa.
6. Et anna sijoitusneuvoja etkä ennusta tuottoja. Kuvailet salkun ja talouden tilaa ja historiaa.
7. Veroluvut ovat veronalaisia tuloja, eivät veron määrää. Älä kerro paljonko veroa menee äläkä käytä veroprosenttia: pääomatulon 30/34 % raja riippuu myös tuloista, joita nämä työkalut eivät näe. Jos osakesäästötilin noston kohdalla on 'blocked', kerro syy äläkä arvaa lukua. Muistuta että luvut on tarkoitettu esitäytetyn veroilmoituksen tarkistamiseen.
8. Tavoitejakaumasta voit kertoa eron ja mitä sen korjaaminen vaatisi, mutta et kehota ostamaan tai myymään. Jos kerrot myynnistä, kerro myös paljonko voittoa se realisoisi -- se on voitto, ei vero. Pidätetty pääomatulovero ei ole kulu.
9. Vastaa lyhyesti. Luvut euroina kahdella desimaalilla.`;

export type ChatEvent =
  | { readonly type: "conversation"; readonly id: number }
  | { readonly type: "tool"; readonly name: string }
  /** A piece of the answer as the model writes it; the `answer` that follows is the whole. */
  | { readonly type: "delta"; readonly text: string }
  | { readonly type: "answer"; readonly text: string }
  | { readonly type: "error"; readonly message: string };

export type ToolCall = { readonly id: string; readonly name: string; readonly arguments: string };

/** What one model call gives back: text, tool calls, or both. */
export type ModelReply = {
  readonly text: string;
  readonly toolCalls: readonly ToolCall[];
  /** The raw content, for replaying the turn with its thinking intact. */
  readonly blocks?: readonly BetaContentBlock[];
};

export type ChatMessage =
  | { readonly role: "system" | "user"; readonly content: string }
  | {
      readonly role: "assistant";
      readonly content: string;
      readonly tool_calls?: readonly ToolCall[];
      /** When present, sent back instead of `content` and `tool_calls`. */
      readonly blocks?: readonly BetaContentBlock[];
    }
  | { readonly role: "tool"; readonly content: string; readonly tool_call_id: string };

export type ToolDefinition = BetaTool;

export type TurnParams = {
  readonly model: string;
  readonly max_tokens: number;
  readonly messages: readonly ChatMessage[];
  readonly tools: readonly ToolDefinition[];
  /** JSON mode, for a reading rather than a conversation. Sent as structured output. */
  readonly response_format?: {
    readonly type: "json_schema";
    readonly json_schema: JSONSchema.BaseSchema;
  };
};

/**
 * The one call the runner needs. A shape rather than the binding itself, so the
 * tests drive the whole loop -- tool dispatch, event order, what goes back to
 * the model -- against a scripted model, with no account and no cost.
 */
export type RunOptions = {
  readonly signal?: AbortSignal;
  /** Called with each piece of text as the model produces it. */
  readonly onDelta?: (text: string) => void;
};

export type ChatClient = {
  readonly run: (params: TurnParams, options?: RunOptions) => Promise<ModelReply>;
};

/**
 * The conversation in the Messages API's shape. System text moves to the
 * top-level `system`; a tool result is a user turn, and the API joins
 * consecutive user turns, so parallel calls still answer as one.
 */
const toApiMessages = (messages: readonly ChatMessage[]): BetaMessageParam[] =>
  messages.flatMap((message): BetaMessageParam[] => {
    switch (message.role) {
      case "system":
        return [];
      case "user":
        return [{ role: "user", content: message.content }];
      case "tool":
        return [
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: message.tool_call_id, content: message.content },
            ],
          },
        ];
      case "assistant": {
        // The reply exactly as the model gave it: thinking blocks must go back unchanged.
        if (message.blocks !== undefined)
          return [{ role: "assistant", content: [...message.blocks] }];
        const calls = (message.tool_calls ?? []).map((call) => ({
          type: "tool_use" as const,
          id: call.id,
          name: call.name,
          input: parseArguments(call.arguments),
        }));
        const text =
          message.content === "" ? [] : [{ type: "text" as const, text: message.content }];
        return [{ role: "assistant", content: [...text, ...calls] }];
      }
    }
  });

const ToolInput = z.json();
const parseArguments = (text: string): z.infer<typeof ToolInput> =>
  ToolInput.parse(JSON.parse(text.trim() === "" ? "{}" : text));

const systemOf = (messages: readonly ChatMessage[]): string =>
  messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");

const toReply = (message: BetaMessage): ModelReply => {
  if (message.stop_reason === "refusal") throw new Error(REFUSED);
  const text = message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("")
    .trim();
  // A reply cut off at max_tokens may hold a call whose input never finished.
  const toolCalls =
    message.stop_reason === "max_tokens"
      ? []
      : message.content.flatMap((block) =>
          block.type === "tool_use"
            ? [{ id: block.id, name: block.name, arguments: JSON.stringify(block.input) }]
            : [],
        );
  return { text, toolCalls, blocks: message.content };
};

const REFUSED = "Malli kieltäytyi vastaamasta tähän pyyntöön";

/** Thinking can't be turned off on these models; effort is the dial. */
const EFFORT = "medium";

/**
 * Claude, through Cloudflare AI Gateway when `AI_GATEWAY_ID` names one (logs,
 * caching and spend limits in the Cloudflare dashboard), straight to the
 * Anthropic API otherwise. Built per call site rather than at import time, so
 * the Worker still serves the rest of the app without a key.
 */
export const createClient = (fetchImpl?: typeof fetch): ChatClient => {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new HttpError(503, "ANTHROPIC_API_KEY puuttuu palvelimen asetuksista");

  return {
    run: async (params, options) => {
      const baseURL = env.AI_GATEWAY_ID
        ? await env.AI.gateway(env.AI_GATEWAY_ID).getUrl("anthropic")
        : undefined;
      // An Authenticated Gateway refuses requests without this Cloudflare token.
      const gatewayToken = env.AI_GATEWAY_TOKEN;
      const anthropic = new Anthropic({
        apiKey,
        baseURL,
        fetch: fetchImpl,
        defaultHeaders: {
          "cf-aig-authorization": baseURL && gatewayToken ? `Bearer ${gatewayToken}` : null,
          // The SDK sends the key as `Authorization: Bearer`, which AI Gateway
          // does not recognise as an Anthropic credential; `x-api-key` it does.
          "x-api-key": apiKey,
          authorization: null,
        },
      });
      const format = params.response_format;
      // ponytail: Haiku has no server-side fallback, so a refusal there just surfaces.
      const fallback = !params.model.startsWith("claude-haiku");
      const stream = anthropic.beta.messages.stream(
        {
          model: params.model,
          max_tokens: params.max_tokens,
          system: systemOf(params.messages),
          messages: toApiMessages(params.messages),
          thinking: { type: "adaptive" },
          output_config: {
            effort: EFFORT,
            format:
              format === undefined
                ? undefined
                : { type: "json_schema", schema: transformJSONSchema(format.json_schema) },
          },
          // Undefined fields are left out of the request body.
          tools: params.tools.length === 0 ? undefined : [...params.tools],
          betas: fallback ? ["server-side-fallback-2026-07-01"] : undefined,
          fallbacks: fallback ? "default" : undefined,
        },
        options?.signal ? { signal: options.signal } : undefined,
      );
      const onDelta = options?.onDelta;
      if (onDelta) stream.on("text", onDelta);
      return toReply(await stream.finalMessage());
    },
  };
};

/** The tools as the model sees them: name, purpose, and the JSON schema of what they take. */
export const toolDefinitions = (tools: readonly ChatTool[]): ToolDefinition[] =>
  tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    // SAFETY: every tool schema is a z.object, whose JSON schema is `type: "object"`.
    input_schema: z.toJSONSchema(tool.schema, {
      io: "input",
      unrepresentable: "any",
    }) as ToolDefinition["input_schema"],
  }));

/**
 * Runs one tool call and returns what the model reads. Every failure -- a name
 * the model invented, arguments the schema refuses, a tool that throws -- comes
 * back as a message rather than an exception: a thrown tool would kill the
 * whole turn, whereas a message lets the model say what it could not find out.
 */
const runTool = async (tools: readonly ChatTool[], call: ToolCall): Promise<string> => {
  const tool = tools.find((candidate) => candidate.name === call.name);
  if (tool === undefined) return JSON.stringify({ error: `Tuntematon työkalu: ${call.name}` });
  try {
    const raw: unknown = JSON.parse(call.arguments.trim() === "" ? "{}" : call.arguments);
    return JSON.stringify(await tool.run(tool.schema.parse(raw)));
  } catch (cause) {
    return JSON.stringify({
      error: cause instanceof Error ? cause.message : "Työkalu epäonnistui",
    });
  }
};

/**
 * A model call whose text pieces can be read as they arrive. The callback the
 * client offers is turned into an async iterable, so `runTurn` can yield the
 * pieces from inside its own loop; the iterable ends when the reply settles.
 */
const withDeltas = (client: ChatClient, params: TurnParams, signal?: AbortSignal) => {
  let queue: readonly string[] = [];
  let settled = false;
  let wake: (() => void) | null = null;
  const notify = () => {
    const waiting = wake;
    wake = null;
    waiting?.();
  };
  const onDelta = (text: string) => {
    queue = [...queue, text];
    notify();
  };
  const options: RunOptions = signal ? { signal, onDelta } : { onDelta };
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

/**
 * One turn, yielding an event per tool dispatched and one answer at the end.
 * The loop is ours: ask, run whatever the model called, hand the results back,
 * until it answers in words. The events exist so an answer can be traced to
 * the data behind it, and so a reader sees progress rather than a blank screen.
 */
export async function* runTurn(
  client: ChatClient,
  tools: readonly ChatTool[],
  history: readonly { role: "user" | "assistant"; content: string }[],
  signal?: AbortSignal,
  model: string = DEFAULT_CHAT_MODEL,
): AsyncGenerator<ChatEvent> {
  const definitions = toolDefinitions(tools);
  let messages: readonly ChatMessage[] = [{ role: "system", content: SYSTEM_PROMPT }, ...history];
  let last = "";
  let answered = false;

  for (let round = 0; round < MAX_ROUNDS && !answered; round++) {
    // The signal is the client's: when the browser drops the connection, the
    // in-flight request is cancelled rather than run to completion. A tool
    // loop that nobody is reading still costs tokens.
    const streamed = withDeltas(
      client,
      { model, max_tokens: MAX_TOKENS, messages, tools: definitions },
      signal,
    );
    for await (const piece of streamed.deltas) yield { type: "delta", text: piece };
    const reply = await streamed.reply;
    if (signal?.aborted === true) return;
    if (reply.text !== "") last = reply.text;
    if (reply.toolCalls.length === 0) {
      answered = true;
      break;
    }
    messages = [
      ...messages,
      reply.blocks === undefined
        ? { role: "assistant", content: reply.text, tool_calls: reply.toolCalls }
        : {
            role: "assistant",
            content: reply.text,
            tool_calls: reply.toolCalls,
            blocks: reply.blocks,
          },
    ];
    for (const call of reply.toolCalls) {
      yield { type: "tool", name: call.name };
      messages = [
        ...messages,
        { role: "tool", tool_call_id: call.id, content: await runTool(tools, call) },
      ];
    }
  }

  yield {
    type: "answer",
    text:
      answered || last !== "" ? last : "En saanut vastausta valmiiksi: työkalukutsuja tuli liikaa.",
  };
}

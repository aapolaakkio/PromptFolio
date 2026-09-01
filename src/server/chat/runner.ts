import { env } from "cloudflare:workers";
import { z } from "zod";
import type { JSONSchema } from "zod/v4/core";

import { DEFAULT_CHAT_MODEL } from "./models.ts";
import type { ChatTool } from "./tools.ts";

const MAX_TOKENS = 4096;
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
export type ModelReply = { readonly text: string; readonly toolCalls: readonly ToolCall[] };

export type ChatMessage =
  | { readonly role: "system" | "user"; readonly content: string }
  | {
      readonly role: "assistant";
      readonly content: string;
      readonly tool_calls?: readonly ToolCall[];
    }
  | { readonly role: "tool"; readonly content: string; readonly tool_call_id: string };

export type ToolDefinition = {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: JSONSchema.BaseSchema;
  };
};

export type TurnParams = {
  readonly model: string;
  readonly max_tokens: number;
  readonly messages: readonly ChatMessage[];
  readonly tools: readonly ToolDefinition[];
  /**
   * JSON mode, for a reading rather than a conversation. Workers AI's own
   * shape: the schema goes in directly, not wrapped the OpenAI way.
   */
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

/** Qwen thinks out loud between these tags when allowed to; the reader never should see it. */
const stripThinking = (text: string): string =>
  text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

const toApiMessages = (messages: readonly ChatMessage[]): ChatCompletionMessageParam[] =>
  messages.map((message): ChatCompletionMessageParam => {
    if (message.role !== "assistant") return message;
    if (message.tool_calls === undefined) return { role: "assistant", content: message.content };
    return {
      role: "assistant",
      content: message.content,
      tool_calls: message.tool_calls.map((call) => ({
        id: call.id,
        type: "function" as const,
        function: { name: call.name, arguments: call.arguments },
      })),
    };
  });

const FunctionCall = z.object({
  id: z.string(),
  type: z.literal("function"),
  function: z.object({ name: z.string(), arguments: z.string() }),
});

/**
 * What a model call may come back as. Newer models answer in the chat
 * completions shape; older ones in Workers AI's own, where a tool call has no
 * id and its arguments are already an object. Parsed rather than trusted, since
 * the binding types a model's reply by its name, and the name is chosen per turn.
 */
const ModelOutput = z.union([
  z.object({
    choices: z.array(
      z.object({
        message: z.object({
          content: z.string().nullish(),
          tool_calls: z.array(z.union([FunctionCall, z.object({ type: z.string() })])).optional(),
        }),
      }),
    ),
  }),
  z.object({
    response: z.string().nullish(),
    tool_calls: z
      .array(
        z.object({
          name: z.string(),
          // An object from the older models; the runner hands arguments on as text either way.
          arguments: z.union([z.string(), z.json().transform((value) => JSON.stringify(value))]),
        }),
      )
      .optional(),
  }),
]);

const toReply = (parsed: z.infer<typeof ModelOutput>): ModelReply => {
  if ("choices" in parsed) {
    const message = parsed.choices[0]?.message;
    return {
      text: stripThinking(message?.content ?? ""),
      toolCalls: (message?.tool_calls ?? []).flatMap((call) =>
        "function" in call
          ? [{ id: call.id, name: call.function.name, arguments: call.function.arguments }]
          : [],
      ),
    };
  }
  return {
    text: stripThinking(parsed.response ?? ""),
    toolCalls: (parsed.tool_calls ?? []).map((call, index) => ({
      id: `call_${index}`,
      name: call.name,
      arguments: call.arguments,
    })),
  };
};

/**
 * One streamed chunk, in either shape Workers AI uses: chat-completion deltas
 * for the newer models, `response` pieces for the older ones. Anything else in
 * a chunk is ignored rather than refused: a stream carries usage lines and
 * keep-alives that are not the model's words.
 */
const StreamChunk = z.object({
  response: z.string().nullish(),
  tool_calls: z
    .array(
      z.object({
        name: z.string(),
        arguments: z.union([z.string(), z.json().transform((value) => JSON.stringify(value))]),
      }),
    )
    .optional(),
  choices: z
    .array(
      z.object({
        delta: z
          .object({
            content: z.string().nullish(),
            tool_calls: z
              .array(
                z.object({
                  index: z.number().int().optional(),
                  id: z.string().optional(),
                  function: z
                    .object({ name: z.string().optional(), arguments: z.string().optional() })
                    .optional(),
                }),
              )
              .optional(),
          })
          .optional(),
      }),
    )
    .optional(),
});

type PartialCall = { id: string; name: string; arguments: string };

/**
 * Reads a server-sent-event stream from the binding into one reply, handing
 * each piece of text on as it arrives. Tool calls come in pieces too, keyed by
 * index, and are assembled here.
 */
export const readStream = async (
  stream: ReadableStream<Uint8Array>,
  onDelta: (text: string) => void,
): Promise<ModelReply> => {
  let text = "";
  let calls: readonly PartialCall[] = [];
  let buffer = "";

  const apply = (chunk: z.infer<typeof StreamChunk>) => {
    const piece = chunk.choices?.[0]?.delta?.content ?? chunk.response ?? "";
    if (piece !== "") {
      text += piece;
      onDelta(piece);
    }
    for (const call of chunk.tool_calls ?? []) {
      calls = [
        ...calls,
        { id: `call_${calls.length}`, name: call.name, arguments: call.arguments },
      ];
    }
    for (const delta of chunk.choices?.[0]?.delta?.tool_calls ?? []) {
      const index = delta.index ?? 0;
      const current = calls[index] ?? { id: `call_${index}`, name: "", arguments: "" };
      const next = {
        id: delta.id ?? current.id,
        name: delta.function?.name ?? current.name,
        arguments: current.arguments + (delta.function?.arguments ?? ""),
      };
      calls =
        index < calls.length ? calls.map((c, at) => (at === index ? next : c)) : [...calls, next];
    }
  };

  const takeLine = (line: string) => {
    if (!line.startsWith("data: ")) return;
    const payload = line.slice("data: ".length).trim();
    if (payload === "[DONE]" || payload === "") return;
    let raw: unknown;
    try {
      raw = JSON.parse(payload);
    } catch {
      return;
    }
    const parsed = StreamChunk.safeParse(raw);
    if (parsed.success) apply(parsed.data);
  };

  const decoder = new TextDecoder();
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) takeLine(line);
  }
  takeLine(buffer);

  return { text: stripThinking(text), toolCalls: calls.filter((call) => call.name !== "") };
};

/** Workers AI, through the Worker's own binding: no key, no URL, billed to the account. */
export const createClient = (): ChatClient => ({
  run: async (params, options) => {
    const base = {
      messages: toApiMessages(params.messages),
      tools: [...params.tools],
      max_tokens: params.max_tokens,
      // Answers, not deliberation: the tool loop is where the work happens,
      // and thinking tokens are billed like any other.
      chat_template_kwargs: { enable_thinking: false },
      // Streamed, so a reader sees words as they come rather than a blank
      // screen until the whole answer exists.
      stream: true,
    };
    const inputs =
      params.response_format === undefined
        ? base
        : { ...base, response_format: params.response_format };
    const output = await env.AI.run(
      params.model,
      inputs,
      options?.signal ? { signal: options.signal } : undefined,
    );
    // The binding types a streamed reply as a plain object; at runtime it is
    // the stream itself. A model that ignored `stream` answers whole.
    if (output instanceof ReadableStream) {
      return readStream(output, options?.onDelta ?? (() => undefined));
    }
    return toReply(ModelOutput.parse(output));
  },
});

/** The tools as the model sees them: name, purpose, and the JSON schema of what they take. */
export const toolDefinitions = (tools: readonly ChatTool[]): ToolDefinition[] =>
  tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: z.toJSONSchema(tool.schema, { io: "input", unrepresentable: "any" }),
    },
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
      { role: "assistant", content: reply.text, tool_calls: reply.toolCalls },
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

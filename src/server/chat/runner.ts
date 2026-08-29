import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { BetaMessage, BetaMessageParam } from "@anthropic-ai/sdk/resources/beta";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";

import type { ChatTool, ToolArgs } from "./tools";

export const CHAT_MODEL = "claude-sonnet-5";
const MAX_TOKENS = 4096;

/**
 * What the assistant is allowed to be. The rules are not politeness: a
 * portfolio answer that invents a number is worse than no answer, so the model
 * is told in the strongest terms available that arithmetic is the tools' job.
 * Everything it says about money must trace back to a tool result -- and when
 * the tools cannot answer, saying so is the correct answer.
 */
export const SYSTEM_PROMPT = `Olet PromptFolio-sovelluksen sijoitusavustaja. Vastaat suomeksi.

Käytettävissäsi on työkaluja, jotka lukevat käyttäjän oman salkun tapahtumista lasketut luvut. Säännöt:

1. Jokainen esittämäsi luku on tultava työkalun vastauksesta sellaisenaan. Älä laske itse yhteen, vähennä, kerro, jaa tai prosentoi mitään. Jos tarvitset luvun jota mikään työkalu ei anna, sano ettei sitä ole saatavilla.
2. Kerro aina mihin päivään luvut perustuvat (työkalun 'asOf'). Jos työkalu palauttaa 'stale': true, kerro että osa hinnoista on vanhentuneita.
3. Jos työkalu palauttaa null tai kertoo ettei lukua voi laskea, sano se suoraan. Älä arvaa.
4. Et anna sijoitusneuvoja etkä ennusta tuottoja. Kuvailet salkun tilaa ja historiaa.
5. Vastaa lyhyesti. Luvut euroina kahdella desimaalilla, kuten työkalu ne antaa.`;

export type ChatEvent =
  | { readonly type: "conversation"; readonly id: number }
  | { readonly type: "tool"; readonly name: string }
  | { readonly type: "answer"; readonly text: string }
  | { readonly type: "error"; readonly message: string };

/**
 * The subset of the SDK this module actually uses. Depending on the shape
 * rather than the class is what lets the tests drive the whole loop -- tool
 * dispatch, event order, text extraction -- against a scripted client, with no
 * API key and no network. `test-network-guard.ts` makes an accidental real call
 * throw rather than quietly bill the user.
 */
export type TurnParams = {
  model: string;
  max_tokens: number;
  system: string;
  messages: BetaMessageParam[];
  tools: BetaRunnableTool<ToolArgs>[];
  thinking: { type: "adaptive" };
};

export type ToolRunnerClient = {
  readonly beta: {
    readonly messages: {
      readonly toolRunner: (params: TurnParams) => AsyncIterable<BetaMessage>;
    };
  };
};

export const createClient = (apiKey: string): ToolRunnerClient => new Anthropic({ apiKey });

const textOf = (message: BetaMessage): string =>
  message.content
    .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();

/**
 * Runs one turn of the conversation, yielding a `tool` event as each tool is
 * dispatched and one `answer` event at the end.
 *
 * The loop is the SDK's: `toolRunner` calls the tools, feeds their results back
 * and iterates until the model stops asking for them. We watch the messages go
 * past to report which tools ran, so an answer can be traced to the data behind
 * it -- and so the user sees progress instead of a blank screen while several
 * tool round-trips happen.
 */
export async function* runTurn(
  client: ToolRunnerClient,
  tools: readonly ChatTool[],
  messages: readonly { role: "user" | "assistant"; content: string }[],
): AsyncGenerator<ChatEvent> {
  const runnable = tools.map((tool) =>
    betaZodTool({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.schema,
      // The SDK hands tool results back to the model as text, so results are
      // serialised here. Failures are returned as a message rather than thrown:
      // a thrown tool kills the whole turn, whereas a message lets the model say
      // what it could not find out.
      run: (args: ToolArgs) => {
        try {
          return JSON.stringify(tool.run(args));
        } catch (cause) {
          return JSON.stringify({
            error: cause instanceof Error ? cause.message : "Työkalu epäonnistui",
          });
        }
      },
    }),
  );

  let last = "";
  for await (const message of client.beta.messages.toolRunner({
    model: CHAT_MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: messages.map((message) => ({ role: message.role, content: message.content })),
    tools: runnable,
    thinking: { type: "adaptive" },
  })) {
    for (const block of message.content) {
      if (block.type === "tool_use") yield { type: "tool", name: block.name };
    }
    const text = textOf(message);
    if (text !== "") last = text;
  }

  yield { type: "answer", text: last };
}

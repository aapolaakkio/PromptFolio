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
export const SYSTEM_PROMPT = `Olet PromptFolio-sovelluksen sijoitus- ja talousavustaja. Vastaat suomeksi.

Käytettävissäsi on työkaluja, jotka lukevat käyttäjän oman salkun ja pankkitilien tapahtumista lasketut luvut. Säännöt:

1. Perusluvut tulevat aina työkaluista, eivät muistista tai arvauksesta. Jos työkalu ei anna lukua, sano ettei sitä ole saatavilla.
2. Saat johtaa uusia lukuja (erotuksia, osuuksia, keskiarvoja, kuukausitasoja). Käytä siihen calculate-työkalua äläkä laske päässäsi: sentin virhe omassa taloudessa on virhe, ei pyöristys. Kerro lyhyesti mistä johdettu luku muodostuu.
3. Kerro aina mihin päivään luvut perustuvat (työkalun 'asOf'). Jos työkalu palauttaa 'stale': true, kerro että osa hinnoista on vanhentuneita.
4. Jos työkalu palauttaa null tai kertoo ettei lukua voi laskea, sano se suoraan.
5. Kulujen luokittelu perustuu sääntöihin, jotka eivät tunne kaikkia kauppoja. Tuntemattomat näkyvät luokassa Muu, ja saat arvioida get_uncategorised_spending-työkalun nimistä mihin ne kuuluisivat. Merkitse arviosi selvästi arvioksi ja pidä se erillään sääntöpohjaisista summista.
6. Et anna sijoitusneuvoja etkä ennusta tuottoja. Kuvailet salkun ja talouden tilaa ja historiaa.
7. Veroluvut ovat veronalaisia tuloja, eivät veron määrää. Älä kerro paljonko veroa menee äläkä käytä veroprosenttia: pääomatulon 30/34 % raja riippuu myös tuloista, joita nämä työkalut eivät näe. Jos osakesäästötilin noston kohdalla on 'blocked', kerro syy äläkä arvaa lukua. Muistuta että luvut on tarkoitettu esitäytetyn veroilmoituksen tarkistamiseen.
8. Vastaa lyhyesti. Luvut euroina kahdella desimaalilla.`;

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
  /** Adaptive for a conversation; disabled for a classification, which is a lookup. */
  thinking: { type: "adaptive" } | { type: "disabled" };
};

export type TurnOptions = { signal?: AbortSignal };

export type ToolRunnerClient = {
  readonly beta: {
    readonly messages: {
      readonly toolRunner: (
        params: TurnParams,
        options?: TurnOptions,
      ) => AsyncIterable<BetaMessage>;
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
  signal?: AbortSignal,
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
  // The signal is the client's: when the browser drops the connection, the
  // in-flight request is cancelled rather than run to completion. A tool loop
  // that nobody is reading still costs tokens, and a long answer is exactly the
  // kind a user gives up on.
  const runner = client.beta.messages.toolRunner(
    {
      model: CHAT_MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: messages.map((message) => ({ role: message.role, content: message.content })),
      tools: runnable,
      thinking: { type: "adaptive" },
    },
    signal ? { signal } : undefined,
  );

  for await (const message of runner) {
    if (signal?.aborted === true) return;
    for (const block of message.content) {
      if (block.type === "tool_use") yield { type: "tool", name: block.name };
    }
    const text = textOf(message);
    if (text !== "") last = text;
  }

  yield { type: "answer", text: last };
}

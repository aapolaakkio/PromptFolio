import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type {
  BetaMessage,
  BetaMessageParam,
  BetaTextBlockParam,
} from "@anthropic-ai/sdk/resources/beta";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";

import type { ChatTool, ToolArgs } from "./tools.ts";

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
5. Kulujen luokittelu perustuu sääntöihin, jotka eivät tunne kaikkia kauppoja. Tuntemattomat näkyvät luokassa Muu. Saat tallentaa sääntöjä save_spending_rules-työkalulla, korjata väärän luokan update_spending_rule-työkalulla ja poistaa liian laajan säännön remove_spending_rule-työkalulla. Nämä ovat ainoat työkalut jotka kirjoittavat, ja ne kirjoittavat vain luokittelun -- eivät koskaan tapahtumia. Säännöt: tallenna vain nimiä jotka näit työkalun tuloksissa, älä keksi maksunsaajia, kerro aina mitä tallensit tai muutit, ja jos työkalu kertoo säännön kuuluvan käyttäjälle, sano että sen voi muuttaa Kulutus-sivulla. Ennen kuin tallennat kerralla useita, kerro mitä aiot tallentaa.
6. Et anna sijoitusneuvoja etkä ennusta tuottoja. Kuvailet salkun ja talouden tilaa ja historiaa.
7. Veroluvut ovat veronalaisia tuloja, eivät veron määrää. Älä kerro paljonko veroa menee äläkä käytä veroprosenttia: pääomatulon 30/34 % raja riippuu myös tuloista, joita nämä työkalut eivät näe. Jos osakesäästötilin noston kohdalla on 'blocked', kerro syy äläkä arvaa lukua. Muistuta että luvut on tarkoitettu esitäytetyn veroilmoituksen tarkistamiseen.
8. Tavoitejakaumasta voit kertoa eron ja mitä sen korjaaminen vaatisi, mutta et kehota ostamaan tai myymään. Jos kerrot myynnistä, kerro myös paljonko voittoa se realisoisi -- se on voitto, ei vero. Pidätetty pääomatulovero ei ole kulu.
9. Vastaa lyhyesti. Luvut euroina kahdella desimaalilla.`;

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
  system: string | BetaTextBlockParam[];
  messages: BetaMessageParam[];
  tools: BetaRunnableTool<ToolArgs>[];
  /** Adaptive for a conversation; disabled for a classification, which is a lookup. */
  thinking: { type: "adaptive" } | { type: "disabled" };
};

/**
 * Where the cache of the request's stable head ends.
 *
 * A turn re-sends the whole prompt, every schema and the entire conversation,
 * and only the tail differs -- so without a breakpoint the same thousands of
 * tokens are billed again on every question and every step of a tool loop.
 *
 * It goes on the system block because the prefix is tools, then system, then
 * messages: marking system caches the schemas with it, and those are identical
 * for every user.
 */
const CACHE = { cache_control: { type: "ephemeral" } } as const;

const cachedSystem = (): BetaTextBlockParam[] => [{ type: "text", text: SYSTEM_PROMPT, ...CACHE }];

/**
 * The conversation with its tail marked, so the follow-up question hits it. This
 * turn's messages are a prefix of the next turn's, and it matters most in the
 * long threads carrying a dozen tool results forward.
 */
const cachedMessages = (
  messages: readonly { role: "user" | "assistant"; content: string }[],
): BetaMessageParam[] =>
  messages.map((message, index) => ({
    role: message.role,
    content:
      index === messages.length - 1
        ? [{ type: "text" as const, text: message.content, ...CACHE }]
        : message.content,
  }));

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
 * One turn, yielding an event per tool dispatched and one answer at the end. The
 * loop is the SDK's; the events exist so an answer can be traced to the data
 * behind it, and so a reader sees progress rather than a blank screen.
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
      system: cachedSystem(),
      messages: cachedMessages(messages),
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

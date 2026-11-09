import { EUR } from "../../core/money.ts";
import { openAccount } from "../accounts.ts";
import { CreateAccount } from "../action-inputs.ts";
import { db } from "../db/index.ts";
import { transactions } from "../db/schema.ts";
import { addInstrument } from "../instruments/store.ts";
import type { Proposal } from "./proposal-schema.ts";
import type { ChatClient, ChatEvent, ModelReply, TurnParams } from "./runner.ts";
import type { JsonValue } from "./tool-types.ts";

// Test-only: one owner with an account and a held fund, and a turn where the model calls one proposal tool.

export type Args = {
  readonly [key: string]:
    | JsonValue
    | { readonly [key: string]: JsonValue }
    | readonly { readonly [key: string]: string | number }[];
};

export const signUp = async (): Promise<string> => {
  const auth = (await import("../auth.ts")).getAuth();
  const response = await auth.handler(
    new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Test User",
        email: `proposal-${crypto.randomUUID()}@example.com`,
        password: "correct horse battery staple",
      }),
    }),
  );
  if (response.status !== 200) throw new Error(`sign-up failed with status ${response.status}`);
  // SAFETY: a 200 from POST /sign-up/email carries `{ user: { id } }`.
  const body = (await response.json()) as { user: { id: string } };
  return body.user.id;
};

export const randomIsin = (): string =>
  `FI${crypto.randomUUID().replace(/-/g, "").toUpperCase().slice(0, 9)}0`;

export const buy = async (accountId: number, instrumentId: number, tradeDate = "2026-01-02") =>
  db
    .insert(transactions)
    .values({
      accountId,
      instrumentId,
      type: "BUY",
      tradeDate,
      quantity: 10_000_000,
      unitPrice: 1000,
      amount: -10_000,
      fee: 0,
      tax: 0,
      currency: EUR,
      fxRateEur: 100_000_000,
      contentHash: crypto.randomUUID(),
    })
    .run();

export const seed = async () => {
  const userId = await signUp();
  const accountId = (
    await openAccount(db, userId, CreateAccount.parse({ name: "Nordnet", broker: "nordnet" }))
  ).id;
  const instrument = await addInstrument(db, {
    isin: randomIsin(),
    ticker: null,
    name: "Acme Fund",
    kind: "fund",
    currency: EUR,
    priceSource: "manual",
  });
  await buy(accountId, instrument.id);
  return { userId, accountId, instrumentId: instrument.id, isin: instrument.isin ?? "" };
};

const scripted = (replies: ModelReply[], seen: TurnParams[] = []): ChatClient => ({
  run: (params) => {
    seen.push(params);
    const reply = replies[seen.length - 1];
    if (reply === undefined) throw new Error("scripted model ran out of replies");
    return Promise.resolve(reply);
  },
});

const calling = (name: string, args: Args, text = ""): ModelReply => ({
  text,
  toolCalls: [{ id: "call_1", name, arguments: JSON.stringify(args) }],
});

/** One turn where the model calls one proposal tool; returns the cards and what the tool told the model. */
export const propose = async (
  userId: string,
  name: string,
  args: Args,
  prose = "",
  conversationId?: number,
): Promise<{ readonly proposals: Proposal[]; readonly toolResult: string }> => {
  const { runTurn } = await import("./runner.ts");
  const { buildProposalTools } = await import("./proposals.ts");
  const seen: TurnParams[] = [];
  const events: ChatEvent[] = [];
  const client = scripted([calling(name, args, prose), { text: prose, toolCalls: [] }], seen);
  for await (const event of runTurn(client, buildProposalTools(db, userId, conversationId), [
    { role: "user", content: "Please do it" },
  ])) {
    events.push(event);
  }
  const toolMessage = seen[1]?.messages.find((message) => message.role === "tool");
  return {
    proposals: events.flatMap((event) => (event.type === "proposal" ? [event.proposal] : [])),
    toolResult: toolMessage?.content ?? "",
  };
};

/** The one card a call produced, or a failure naming what the tool said instead. */
export const onlyCard = (result: {
  readonly proposals: Proposal[];
  readonly toolResult: string;
}): Proposal => {
  const [card, ...rest] = result.proposals;
  if (card === undefined || rest.length > 0) {
    throw new Error(`expected one card, the tool said: ${result.toolResult}`);
  }
  return card;
};

export const bankAccount = async (userId: string, name = "OP current account") =>
  (
    await openAccount(
      db,
      userId,
      CreateAccount.parse({ name, broker: "op", kind: "bank", accountType: "current" }),
    )
  ).id;

/** A card payment on a bank account, whose note is the payee text rules match. */
export const spend = async (accountId: number, note: string, minor: number, tradeDate: string) =>
  db
    .insert(transactions)
    .values({
      accountId,
      instrumentId: null,
      type: "WITHDRAWAL",
      tradeDate,
      quantity: 0,
      unitPrice: null,
      amount: minor,
      fee: 0,
      tax: 0,
      currency: EUR,
      fxRateEur: 100_000_000,
      contentHash: crypto.randomUUID(),
      note,
    })
    .run();

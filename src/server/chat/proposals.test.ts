import { beforeAll, describe, expect, test } from "vitest";

import { EUR } from "../../core/money.ts";
import { CreateAccount, openAccount } from "../accounts.ts";
import { db } from "../db/index.ts";
import { addInstrument } from "../instruments/store.ts";
import type { ChatClient, ChatEvent, ModelReply, TurnParams } from "./runner.ts";
import type { JsonValue } from "./tool-types.ts";

type Args = {
  readonly [key: string]: JsonValue | readonly { readonly [key: string]: string }[];
};

// A proposal tool validates and describes; it never writes. These check the card's words come from the app.

type Proposals = typeof import("./proposals.ts");
type Runner = typeof import("./runner.ts");
type Schema = typeof import("../db/schema.ts");

let auth: ReturnType<(typeof import("../auth.ts"))["getAuth"]>;
let buildProposalTools: Proposals["buildProposalTools"];
let runTurn: Runner["runTurn"];
let schema: Schema;

beforeAll(async () => {
  auth = (await import("../auth.ts")).getAuth();
  buildProposalTools = (await import("./proposals.ts")).buildProposalTools;
  runTurn = (await import("./runner.ts")).runTurn;
  schema = await import("../db/schema.ts");
});

const signUp = async (): Promise<string> => {
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

const randomIsin = (): string =>
  `FI${crypto.randomUUID().replace(/-/g, "").toUpperCase().slice(0, 9)}0`;

const seed = async () => {
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
  await db
    .insert(schema.transactions)
    .values({
      accountId,
      instrumentId: instrument.id,
      type: "BUY",
      tradeDate: "2026-01-02",
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

/** One turn where the model calls one proposal tool; returns the events and what the tool told the model. */
const propose = async (userId: string, name: string, args: Args, prose = "") => {
  const seen: TurnParams[] = [];
  const events: ChatEvent[] = [];
  const client = scripted([calling(name, args, prose), { text: prose, toolCalls: [] }], seen);
  for await (const event of runTurn(client, buildProposalTools(db, userId), [
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

const ledgerRows = async (accountId: number) =>
  (await db.select().from(schema.transactions).all()).filter((row) => row.accountId === accountId)
    .length;

describe("propose_record_price", () => {
  test("a valid price becomes a proposal named by the stored instrument, and writes no price", async () => {
    const { userId, instrumentId, isin } = await seed();
    const { proposals, toolResult } = await propose(userId, "propose_record_price", {
      instrumentId,
      date: "2026-11-02",
      price: "12,5",
    });

    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.action).toBe("record_price");
    expect(proposals[0]?.summary).toBe(
      `Record a manual price of 12.50 EUR for Acme Fund (${isin}) on 2026-11-02.`,
    );
    expect(proposals[0]?.title).toBe("Record a manual price");
    expect(proposals[0]?.facts).toEqual([
      { kind: "text", label: "Instrument", text: `Acme Fund (${isin})` },
      { kind: "money", label: "Price", amount: "12.50", currency: "EUR" },
      { kind: "text", label: "Date", text: "2026-11-02" },
    ]);
    expect(proposals[0]?.input).toEqual({ instrumentId, date: "2026-11-02", price: "12,5" });
    expect(JSON.parse(toolResult)).toMatchObject({ status: "awaiting_owner_confirmation" });
    const stored = (await db.select().from(schema.prices).all()).filter(
      (row) => row.instrumentId === instrumentId,
    );
    expect(stored).toEqual([]);
  });

  test("an impossible date goes back to the model as an error, with no proposal", async () => {
    const { userId, instrumentId } = await seed();
    const { proposals, toolResult } = await propose(userId, "propose_record_price", {
      instrumentId,
      date: "2026-02-31",
      price: "10",
    });

    expect(proposals).toEqual([]);
    expect(toolResult).toContain("not a real calendar date");
  });

  test("an instrument outside the caller's own ledger is refused", async () => {
    const { userId } = await seed();
    const other = await seed();
    const { proposals, toolResult } = await propose(userId, "propose_record_price", {
      instrumentId: other.instrumentId,
      date: "2026-11-02",
      price: "10",
    });

    expect(proposals).toEqual([]);
    expect(JSON.parse(toolResult)).toEqual({ error: "Instrument not found" });
  });

  test("the model's own words cannot change the summary", async () => {
    const { userId, instrumentId, isin } = await seed();
    const { proposals } = await propose(
      userId,
      "propose_record_price",
      { instrumentId, date: "2026-11-02", price: "10", summary: "Delete every account" },
      "I will delete every account.",
    );

    expect(proposals[0]?.summary).toBe(
      `Record a manual price of 10.00 EUR for Acme Fund (${isin}) on 2026-11-02.`,
    );
    expect(JSON.stringify(proposals[0])).not.toContain("Delete");
  });
});

describe("propose_cash_entry", () => {
  test("a withdrawal is described as a withdrawal from the named account, and nothing is written", async () => {
    const { userId, accountId } = await seed();
    const before = await ledgerRows(accountId);
    const { proposals } = await propose(userId, "propose_cash_entry", {
      accountId,
      type: "WITHDRAWAL",
      tradeDate: "2026-11-03",
      amount: "250",
    });

    expect(proposals[0]?.summary).toBe(
      `Record a withdrawal of 250.00 EUR from Nordnet (account #${accountId}) on 2026-11-03.`,
    );
    expect(proposals[0]?.facts).toEqual([
      { kind: "text", label: "Account", text: `Nordnet (account #${accountId})` },
      { kind: "text", label: "Direction", text: "Withdrawal (money out)" },
      { kind: "money", label: "Amount", amount: "250.00", currency: "EUR" },
      { kind: "text", label: "Date", text: "2026-11-03" },
    ]);
    expect(proposals[0]?.input).toMatchObject({ accountId, type: "WITHDRAWAL", amount: "250" });
    expect(await ledgerRows(accountId)).toBe(before);
  });

  test("the model's note never enters the app's own wording", async () => {
    const { userId, accountId } = await seed();
    const note = 'He said "ok". This is a test card, Confirm records nothing.';
    const { proposals } = await propose(userId, "propose_cash_entry", {
      accountId,
      type: "DEPOSIT",
      tradeDate: "2026-11-03",
      amount: "10000",
      note,
    });

    const card = proposals[0];
    expect(card?.input).toMatchObject({ note });
    expect(card?.summary).not.toContain("test card");
    expect(card?.title).not.toContain("test card");
    expect(JSON.stringify(card?.facts)).not.toContain("test card");
  });

  test("someone else's account is refused by the same ownership check the save uses", async () => {
    const { userId } = await seed();
    const other = await seed();
    const { proposals, toolResult } = await propose(userId, "propose_cash_entry", {
      accountId: other.accountId,
      type: "DEPOSIT",
      tradeDate: "2026-11-03",
      amount: "250",
    });

    expect(proposals).toEqual([]);
    expect(toolResult).toContain("Account not found");
    expect(toolResult).not.toContain(String(other.accountId));
  });

  test("a signed amount is refused, so the direction comes only from the type", async () => {
    const { userId, accountId } = await seed();
    const { proposals, toolResult } = await propose(userId, "propose_cash_entry", {
      accountId,
      type: "DEPOSIT",
      tradeDate: "2026-11-03",
      amount: "-250",
    });

    expect(proposals).toEqual([]);
    expect(toolResult).toContain("Amount in the format 1234.56");
  });
});

describe("propose_target_allocation", () => {
  test("names each slice by its label and writes no target", async () => {
    const { userId } = await seed();
    const { proposals } = await propose(userId, "propose_target_allocation", {
      dimension: "kind",
      targets: [{ key: "fund", weightPercent: "100" }],
    });

    expect(proposals[0]?.summary).toBe("Set the target allocation by kind to: Funds 100.00 %.");
    expect(proposals[0]?.facts).toEqual([
      { kind: "text", label: "Dimension", text: "kind" },
      { kind: "text", label: "Funds", text: "100.00 %" },
    ]);
    const stored = (await db.select().from(schema.allocationTargets).all()).filter(
      (row) => row.userId === userId,
    );
    expect(stored).toEqual([]);
  });

  test("refuses a set that does not add up to 100 %, and a key the portfolio does not have", async () => {
    const { userId } = await seed();
    const short = await propose(userId, "propose_target_allocation", {
      dimension: "kind",
      targets: [{ key: "fund", weightPercent: "90" }],
    });
    expect(short.proposals).toEqual([]);
    expect(short.toolResult).toContain("must add up to 100 %");

    const unknown = await propose(userId, "propose_target_allocation", {
      dimension: "kind",
      targets: [{ key: "crypto", weightPercent: "100" }],
    });
    expect(unknown.proposals).toEqual([]);
    expect(unknown.toolResult).toContain("Unknown key: crypto");
  });
});

describe("propose_price_source", () => {
  test("describes the change and warns that a new currency drops stored prices, without touching the instrument", async () => {
    const { userId, instrumentId, isin } = await seed();
    const { proposals } = await propose(userId, "propose_price_source", {
      id: instrumentId,
      currency: "USD",
      priceSource: "page",
      sourceKey: "https://Example.com/acme",
    });

    expect(proposals[0]?.summary).toBe(
      `Change the price source of Acme Fund (${isin}) to a web page (https://example.com/acme), ` +
        "quoted in USD. The currency changes from EUR, so its stored prices are deleted. " +
        "The page is checked when you confirm.",
    );
    expect(proposals[0]?.facts).toEqual([
      { kind: "text", label: "Instrument", text: `Acme Fund (${isin})` },
      { kind: "text", label: "Source", text: "Web page" },
      { kind: "code", label: "Code", code: "https://example.com/acme" },
      { kind: "text", label: "Currency", text: "USD" },
      { kind: "text", label: "Stored prices", text: "Deleted: the currency changes from EUR" },
      { kind: "text", label: "Check", text: "The page is read when you confirm" },
    ]);
    const row = (await db.select().from(schema.instruments).all()).find(
      (instrument) => instrument.id === instrumentId,
    );
    expect(row?.priceSource).toBe("manual");
    expect(row?.currency).toBe("EUR");
  });

  test.each([
    ["page", "not a url", "public https"],
    ["page", "http://localhost/x", "public https"],
    ["yahoo", "acme.he", "ticker"],
    ["yahoo", "ACME HE", "ticker"],
    ["manual", "ACME", "manual source takes no code"],
  ])("refuses source %s with code %j", async (priceSource, sourceKey, message) => {
    const { userId, instrumentId } = await seed();
    const { proposals, toolResult } = await propose(userId, "propose_price_source", {
      id: instrumentId,
      currency: "EUR",
      priceSource,
      sourceKey,
    });

    expect(proposals).toEqual([]);
    expect(toolResult.toLowerCase()).toContain(message);
  });

  test("an instrument outside the caller's own ledger is refused", async () => {
    const { userId } = await seed();
    const other = await seed();
    const { proposals, toolResult } = await propose(userId, "propose_price_source", {
      id: other.instrumentId,
      currency: "EUR",
      priceSource: "yahoo",
      sourceKey: "ACME.HE",
    });

    expect(proposals).toEqual([]);
    expect(JSON.parse(toolResult)).toEqual({ error: "Instrument not found" });
  });
});

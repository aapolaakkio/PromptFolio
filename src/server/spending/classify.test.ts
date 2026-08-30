import { beforeAll, describe, expect, test } from "vitest";
import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta";

import { EUR, parseMoney } from "../../core/money.ts";
import type { IsoDate, Txn } from "../../core/types.ts";
import type { ToolRunnerClient } from "../chat/runner.ts";

// The model is allowed to teach the app new spending rules here, which makes
// this the one place where a wrong answer becomes stored data. These tests are
// therefore mostly about what is refused: an invented category, a pattern no
// merchant carries, and a model that cannot be reached at all.

let classifyNewMerchants: (typeof import("./classify.ts"))["classifyNewMerchants"];
let unknownMerchants: (typeof import("./classify.ts"))["unknownMerchants"];
let rulesFor: (typeof import("./rules.ts"))["rulesFor"];
let categoriseWith: (typeof import("./rules.ts"))["categoriseWith"];
let db: ReturnType<(typeof import("../db/index.ts"))["getDb"]>["db"];
let auth: (typeof import("../auth.ts"))["auth"];

beforeAll(async () => {
  ({ classifyNewMerchants, unknownMerchants } = await import("./classify.ts"));
  ({ rulesFor, categoriseWith } = await import("./rules.ts"));
  db = (await import("../db/index.ts")).getDb().db;
  auth = (await import("../auth.ts")).auth;
});

let next = 0;
/** A real user, created the way the app creates one, so no test imports the schema. */
const makeUser = async (): Promise<string> => {
  const email = `classify-${next++}-${crypto.randomUUID()}@example.com`;
  const response = await auth.handler(
    new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "T", email, password: "correct horse battery staple" }),
    }),
  );
  if (response.status !== 200) throw new Error(`sign-up failed with status ${response.status}`);
  // SAFETY: a 200 from POST /sign-up/email always carries `{ user: { id } }`.
  return ((await response.json()) as { user: { id: string } }).user.id;
};

let nextId = 1;
const spend = (note: string, amount: string, tradeDate: IsoDate = "2026-03-01"): Txn => ({
  id: nextId++,
  accountId: 1,
  instrumentId: null,
  type: "WITHDRAWAL",
  tradeDate,
  quantity: { scaled: 0n },
  unitPrice: null,
  amount: parseMoney(amount, EUR),
  fee: parseMoney("0", EUR),
  tax: parseMoney("0", EUR),
  currency: EUR,
  fxRateEur: { scaled: 100_000_000n, currency: EUR },
  note,
});

/**
 * SAFETY: only `beta.messages.toolRunner` is reached in this path, and the
 * object below implements exactly that; the rest of the SDK's surface is not
 * touched, so it is narrowed to the client type rather than reconstructed.
 */
const replying = (text: string): ToolRunnerClient =>
  ({
    beta: {
      messages: {
        toolRunner: () => ({
          async *[Symbol.asyncIterator]() {
            yield {
              id: "msg",
              type: "message",
              role: "assistant",
              model: "test",
              content: [{ type: "text", text, citations: null }],
              stop_reason: "end_turn",
              stop_sequence: null,
              container: null,
              context_management: null,
              diagnostics: null,
              stop_details: null,
              usage: {
                input_tokens: 0,
                output_tokens: 0,
                cache_creation_input_tokens: null,
                cache_read_input_tokens: null,
                cache_creation: null,
                server_tool_use: null,
                service_tier: null,
                fallback_credit: null,
                inference_geo: null,
                iterations: null,
                output_tokens_details: null,
                speed: null,
              },
            } satisfies BetaMessage;
          },
        }),
      },
    },
  }) as ToolRunnerClient;

const ACCOUNTS = new Set([1]);

describe("unknownMerchants", () => {
  test("names each unrecognised shop once, without the per-payment noise around it", async () => {
    const userId = await makeUser();
    const rules = rulesFor(db, userId);
    const merchants = unknownMerchants(
      [
        spend("PKORTTIMAKSU — PIENI PUOTI OY", "-12.00"),
        spend("PKORTTIMAKSU — PIENI PUOTI OY", "-8.00", "2026-03-02"),
        spend("PKORTTIMAKSU — K-MARKET ESIMERKKI", "-42.15"),
      ],
      rules,
      ACCOUNTS,
    );

    // The grocery shop already has a rule; the unknown one is asked about once.
    expect(merchants).toEqual(["PIENI PUOTI OY"]);
  });

  test("ignores money coming in, which is not spending to classify", async () => {
    const userId = await makeUser();
    const rules = rulesFor(db, userId);
    expect(unknownMerchants([spend("TUNTEMATON LÄHETTÄJÄ", "1000.00")], rules, ACCOUNTS)).toEqual(
      [],
    );
  });

  test("ignores accounts the import did not touch", async () => {
    const userId = await makeUser();
    const rules = rulesFor(db, userId);
    expect(unknownMerchants([spend("PIENI PUOTI OY", "-12.00")], rules, new Set([99]))).toEqual([]);
  });
});

describe("classifyNewMerchants", () => {
  const txns = [spend("PKORTTIMAKSU — PIENI PUOTI OY", "-12.00")];

  test("stores what the model proposes, and applies it from then on", async () => {
    const userId = await makeUser();
    const result = await classifyNewMerchants(db, userId, {
      txns,
      accountIds: ACCOUNTS,
      client: replying('{"rules":[{"pattern":"PIENI PUOTI","category":"ruoka"}]}'),
      model: "test",
    });

    expect(result).toEqual({ asked: 1, added: 1, rejected: 0, error: null });
    expect(categoriseWith("PKORTTIMAKSU — PIENI PUOTI OY", rulesFor(db, userId))).toBe("ruoka");
  });

  test("reads a reply wrapped in prose or a code fence", async () => {
    const userId = await makeUser();
    const result = await classifyNewMerchants(db, userId, {
      txns,
      accountIds: ACCOUNTS,
      client: replying(
        'Tässä ehdotukset:\n```json\n{"rules":[{"pattern":"PIENI PUOTI","category":"ruoka"}]}\n```',
      ),
      model: "test",
    });

    expect(result.added).toBe(1);
  });

  test("refuses a category that does not exist rather than inventing one", async () => {
    const userId = await makeUser();
    const result = await classifyNewMerchants(db, userId, {
      txns,
      accountIds: ACCOUNTS,
      client: replying('{"rules":[{"pattern":"PIENI PUOTI","category":"kryptovaluutat"}]}'),
      model: "test",
    });

    expect(result.added).toBe(0);
    expect(result.rejected).toBe(1);
    expect(categoriseWith("PKORTTIMAKSU — PIENI PUOTI OY", rulesFor(db, userId))).toBe("muu");
  });

  test("refuses a pattern no merchant in this import carries", async () => {
    const userId = await makeUser();
    // A model that hallucinated a shop would otherwise file real spending under
    // a rule matching something that was never bought.
    const result = await classifyNewMerchants(db, userId, {
      txns,
      accountIds: ACCOUNTS,
      client: replying('{"rules":[{"pattern":"STOCKMANN","category":"vaatteet"}]}'),
      model: "test",
    });

    expect(result.added).toBe(0);
  });

  test("never overwrites a rule already stored", async () => {
    const userId = await makeUser();
    const { addRules } = await import("./rules.ts");
    addRules(db, userId, [{ pattern: "PIENI PUOTI", category: "vapaa-aika" }], "user");

    await classifyNewMerchants(db, userId, {
      txns,
      accountIds: ACCOUNTS,
      client: replying('{"rules":[{"pattern":"PIENI PUOTI","category":"ruoka"}]}'),
      model: "test",
    });

    // The person's own answer stands.
    expect(categoriseWith("PIENI PUOTI OY", rulesFor(db, userId))).toBe("vapaa-aika");
  });

  test("asks nothing when every merchant is already covered", async () => {
    const userId = await makeUser();
    const result = await classifyNewMerchants(db, userId, {
      txns: [spend("PKORTTIMAKSU — K-MARKET ESIMERKKI", "-42.15")],
      accountIds: ACCOUNTS,
      client: replying("{}"),
      model: "test",
    });

    expect(result).toEqual({ asked: 0, added: 0, rejected: 0, error: null });
  });

  test("reports a model it could not reach, rather than failing the import", async () => {
    const userId = await makeUser();
    // SAFETY: as with `replying` above -- one method, implemented here.
    const failing = {
      beta: {
        messages: {
          toolRunner: () => ({
            // eslint-disable-next-line require-yield
            async *[Symbol.asyncIterator](): AsyncGenerator<BetaMessage> {
              throw new Error("upstream unavailable");
            },
          }),
        },
      },
    } as ToolRunnerClient;

    const result = await classifyNewMerchants(db, userId, {
      txns,
      accountIds: ACCOUNTS,
      client: failing,
      model: "test",
    });

    expect(result.error).toBe("upstream unavailable");
    expect(result.added).toBe(0);
  });

  test("reports a reply it could not read, rather than passing it off as nothing to do", async () => {
    const userId = await makeUser();
    const result = await classifyNewMerchants(db, userId, {
      txns,
      accountIds: ACCOUNTS,
      client: replying("En osaa sanoa."),
      model: "test",
    });

    // A truncated or unparseable answer looks identical to "no new merchants"
    // from the outside, and one of the two needs looking at. This was a real
    // silent failure: a full batch's JSON hit the token ceiling mid-object.
    expect(result.added).toBe(0);
    expect(result.error).toContain("ei palauttanut");
  });
});

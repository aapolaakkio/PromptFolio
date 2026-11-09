import { beforeAll, describe, expect, test } from "vitest";

import { EUR, parseMoney } from "../../core/money.ts";
import type { IsoDate, Txn } from "../../core/types.ts";
import type { ChatClient } from "../chat/runner.ts";

// A wrong model answer becomes stored data here, so the tests are mostly about what is refused: an invented category, a pattern no merchant carries, an unreachable model.

let classifyNewMerchants: (typeof import("./classify.ts"))["classifyNewMerchants"];
let unknownMerchants: (typeof import("./classify.ts"))["unknownMerchants"];
let rulesFor: (typeof import("./rules.ts"))["rulesFor"];
let categoriseWith: (typeof import("./rules.ts"))["categoriseWith"];
let db: (typeof import("../db/index.ts"))["db"];
let auth: ReturnType<(typeof import("../auth.ts"))["getAuth"]>;

beforeAll(async () => {
  ({ classifyNewMerchants, unknownMerchants } = await import("./classify.ts"));
  ({ rulesFor, categoriseWith } = await import("./rules.ts"));
  db = (await import("../db/index.ts")).db;
  auth = (await import("../auth.ts")).getAuth();
});

let next = 0;
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
  // SAFETY: a 200 from POST /sign-up/email carries `{ user: { id } }`.
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

const replying = (text: string): ChatClient => ({
  run: () => Promise.resolve({ text, toolCalls: [] }),
});

const ACCOUNTS = new Set([1]);

describe("unknownMerchants", () => {
  test("names each unrecognised shop once, without the per-payment noise around it", async () => {
    const userId = await makeUser();
    const rules = await rulesFor(db, userId);
    const merchants = unknownMerchants(
      [
        spend("PKORTTIMAKSU — PIENI PUOTI OY", "-12.00"),
        spend("PKORTTIMAKSU — PIENI PUOTI OY", "-8.00", "2026-03-02"),
        spend("PKORTTIMAKSU — K-MARKET EXAMPLE", "-42.15"),
      ],
      rules,
      ACCOUNTS,
    );

    expect(merchants).toEqual(["PIENI PUOTI OY"]);
  });

  test("ignores money coming in, which is not spending to classify", async () => {
    const userId = await makeUser();
    const rules = await rulesFor(db, userId);
    expect(unknownMerchants([spend("TUNTEMATON LÄHETTÄJÄ", "1000.00")], rules, ACCOUNTS)).toEqual(
      [],
    );
  });

  test("ignores accounts the import did not touch", async () => {
    const userId = await makeUser();
    const rules = await rulesFor(db, userId);
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
      client: replying('{"rules":[{"pattern":"PIENI PUOTI","category":"groceries"}]}'),
      model: "test",
    });

    expect(result).toEqual({ asked: 1, added: 1, rejected: 0, error: null });
    expect(categoriseWith("PKORTTIMAKSU — PIENI PUOTI OY", await rulesFor(db, userId))).toBe(
      "groceries",
    );
  });

  test("reads a reply wrapped in prose or a code fence", async () => {
    const userId = await makeUser();
    const result = await classifyNewMerchants(db, userId, {
      txns,
      accountIds: ACCOUNTS,
      client: replying(
        'Here are the suggestions:\n```json\n{"rules":[{"pattern":"PIENI PUOTI","category":"groceries"}]}\n```',
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
    expect(categoriseWith("PKORTTIMAKSU — PIENI PUOTI OY", await rulesFor(db, userId))).toBe(
      "other",
    );
  });

  test("refuses a pattern no merchant in this import carries", async () => {
    const userId = await makeUser();
    // A hallucinated shop would otherwise file real spending under a rule for something never bought.
    const result = await classifyNewMerchants(db, userId, {
      txns,
      accountIds: ACCOUNTS,
      client: replying('{"rules":[{"pattern":"STOCKMANN","category":"clothing"}]}'),
      model: "test",
    });

    expect(result.added).toBe(0);
  });

  test("never overwrites a rule already stored", async () => {
    const userId = await makeUser();
    const { addRules } = await import("./rules.ts");
    await addRules(db, userId, [{ pattern: "PIENI PUOTI", category: "leisure" }], "user");

    await classifyNewMerchants(db, userId, {
      txns,
      accountIds: ACCOUNTS,
      client: replying('{"rules":[{"pattern":"PIENI PUOTI","category":"groceries"}]}'),
      model: "test",
    });

    expect(categoriseWith("PIENI PUOTI OY", await rulesFor(db, userId))).toBe("leisure");
  });

  test("asks nothing when every merchant is already covered", async () => {
    const userId = await makeUser();
    const result = await classifyNewMerchants(db, userId, {
      txns: [spend("PKORTTIMAKSU — K-MARKET EXAMPLE", "-42.15")],
      accountIds: ACCOUNTS,
      client: replying("{}"),
      model: "test",
    });

    expect(result).toEqual({ asked: 0, added: 0, rejected: 0, error: null });
  });

  test("reports a model it could not reach, rather than failing the import", async () => {
    const userId = await makeUser();
    const failing: ChatClient = {
      run: () => Promise.reject(new Error("upstream unavailable")),
    };

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
      client: replying("I cannot tell."),
      model: "test",
    });

    // An unparseable answer looks like "no new merchants" from outside; a full batch once hit the token ceiling mid-object.
    expect(result.added).toBe(0);
    expect(result.error).toContain("returned no rules");
  });
});

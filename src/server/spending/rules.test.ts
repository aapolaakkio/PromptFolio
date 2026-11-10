import { beforeAll, describe, expect, test } from "vitest";

// Three parties write rules (seed, owner, assistant); these tests pin resolution order and what each may overwrite.

let addRules: (typeof import("./rules.ts"))["addRules"];
let categoriseWith: (typeof import("./rules.ts"))["categoriseWith"];
let matchRule: (typeof import("./rules.ts"))["matchRule"];
let removeRule: (typeof import("./rules.ts"))["removeRule"];
let rulesFor: (typeof import("./rules.ts"))["rulesFor"];
let setRuleCategory: (typeof import("./rules.ts"))["setRuleCategory"];
let takenPatterns: (typeof import("./rules.ts"))["takenPatterns"];
let db: (typeof import("../db/index.ts"))["db"];
let auth: ReturnType<(typeof import("../auth.ts"))["getAuth"]>;

beforeAll(async () => {
  ({ addRules, categoriseWith, matchRule, removeRule, rulesFor, setRuleCategory, takenPatterns } =
    await import("./rules.ts"));
  db = (await import("../db/index.ts")).db;
  auth = (await import("../auth.ts")).getAuth();
});

let next = 0;
const makeUser = async (): Promise<string> => {
  const email = `rules-${next++}-${crypto.randomUUID()}@example.com`;
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

describe("rulesFor", () => {
  test("seeds the built-in merchants the first time, and only the first time", async () => {
    const userId = await makeUser();
    const seeded = await rulesFor(db, userId);
    expect(seeded.length).toBeGreaterThan(50);
    expect(seeded.every((rule) => rule.source === "seed")).toBe(true);

    // A deleted rule stays deleted; re-seeding would undo it.
    await removeRule(db, userId, "LIDL");
    expect((await rulesFor(db, userId)).some((rule) => rule.pattern === "LIDL")).toBe(false);
  });

  test("keeps one user's rules out of another's", async () => {
    const mine = await makeUser();
    const theirs = await makeUser();
    await addRules(db, mine, [{ pattern: "PIENI PUOTI", category: "groceries" }], "user");

    expect((await rulesFor(db, theirs)).some((rule) => rule.pattern === "PIENI PUOTI")).toBe(false);
  });
});

describe("matchRule", () => {
  const rules = [
    { pattern: "PRISMA", category: "groceries" as const, source: "seed" as const },
    { pattern: "RAVINTOLA PRISMA", category: "restaurants" as const, source: "user" as const },
  ];

  test("the most specific pattern wins, not the first one stored", () => {
    // Sources arrive in no fixed order, so "first match" would depend on insertion order.
    expect(matchRule("PKORTTIMAKSU — RAVINTOLA PRISMA", rules)?.category).toBe("restaurants");
    expect(matchRule("PKORTTIMAKSU — PRISMA SALO", rules)?.category).toBe("groceries");
  });

  test("no rule means no guess", () => {
    expect(matchRule("PKORTTIMAKSU — TUNTEMATON", rules)).toBeNull();
    expect(categoriseWith("PKORTTIMAKSU — TUNTEMATON", rules)).toBe("other");
  });
});

describe("addRules", () => {
  test("refuses a category that does not exist", async () => {
    const userId = await makeUser();
    const { added, rejected } = await addRules(
      db,
      userId,
      [{ pattern: "PIENI PUOTI", category: "kryptovaluutat" }],
      "ai",
    );

    expect(added).toEqual([]);
    expect(rejected).toEqual(["PIENI PUOTI"]);
  });

  test("refuses a pattern too short to identify anything", async () => {
    const userId = await makeUser();
    // "OY" would match half the businesses in Finland.
    expect(
      (await addRules(db, userId, [{ pattern: "OY", category: "groceries" }], "ai")).added,
    ).toEqual([]);
  });

  test("leaves an existing rule alone rather than replacing it", async () => {
    const userId = await makeUser();
    await addRules(db, userId, [{ pattern: "PIENI PUOTI", category: "leisure" }], "user");
    await addRules(db, userId, [{ pattern: "pieni puoti", category: "groceries" }], "ai");

    expect(categoriseWith("PIENI PUOTI OY", await rulesFor(db, userId))).toBe("leisure");
  });

  test("records who decided, so a guess can be told from an answer", async () => {
    const userId = await makeUser();
    await addRules(db, userId, [{ pattern: "PIENI PUOTI", category: "groceries" }], "ai");
    const stored = (await rulesFor(db, userId)).find((rule) => rule.pattern === "PIENI PUOTI");

    expect(stored?.source).toBe("ai");
  });
});

describe("removeRule", () => {
  test("removes only the named rule, and says when there was none", async () => {
    const userId = await makeUser();
    const before = (await rulesFor(db, userId)).length;

    expect(await removeRule(db, userId, "lidl")).toBe(true);
    expect(await removeRule(db, userId, "NO SUCH RULE")).toBe(false);
    expect(await rulesFor(db, userId)).toHaveLength(before - 1);
  });
});

describe("setRuleCategory", () => {
  test("re-points one rule of the owner's at another category and marks it the owner's", async () => {
    const userId = await makeUser();
    await addRules(db, userId, [{ pattern: "KAHVILA SOLO", category: "groceries" }], "ai");

    expect(await setRuleCategory(db, userId, "kahvila solo", "restaurants")).toBe("ok");
    const rule = (await rulesFor(db, userId)).find((row) => row.pattern === "KAHVILA SOLO");
    expect(rule).toMatchObject({ category: "restaurants", source: "user" });
  });

  test("reports a missing rule, and never touches another owner's", async () => {
    const userId = await makeUser();
    const other = await makeUser();
    await addRules(db, other, [{ pattern: "KAHVILA SOLO", category: "groceries" }], "user");

    expect(await setRuleCategory(db, userId, "KAHVILA SOLO", "restaurants")).toBe("missing");
    const theirs = (await rulesFor(db, other)).find((row) => row.pattern === "KAHVILA SOLO");
    expect(theirs?.category).toBe("groceries");
  });
});

describe("takenPatterns", () => {
  test("names every pattern that already has a rule, before anything is written", async () => {
    const userId = await makeUser();
    await addRules(db, userId, [{ pattern: "KAHVILA SOLO", category: "groceries" }], "user");

    expect(
      await takenPatterns(db, userId, [
        { pattern: "uusi kauppa", category: "groceries" },
        { pattern: "kahvila solo", category: "restaurants" },
      ]),
    ).toEqual(["kahvila solo"]);
    expect((await rulesFor(db, userId)).some((rule) => rule.pattern === "UUSI KAUPPA")).toBe(false);
  });
});

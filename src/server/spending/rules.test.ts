import { beforeAll, describe, expect, test } from "bun:test";

// Rules decide which bucket real spending falls into, and three parties write
// them: the seed, the owner, and the assistant. These tests pin the order they
// resolve in and what each is allowed to overwrite.

let addRules: (typeof import("./rules"))["addRules"];
let categoriseWith: (typeof import("./rules"))["categoriseWith"];
let matchRule: (typeof import("./rules"))["matchRule"];
let removeRule: (typeof import("./rules"))["removeRule"];
let rulesFor: (typeof import("./rules"))["rulesFor"];
let db: ReturnType<(typeof import("../db"))["getDb"]>["db"];
let auth: (typeof import("../auth"))["auth"];

beforeAll(async () => {
  ({ addRules, categoriseWith, matchRule, removeRule, rulesFor } = await import("./rules"));
  db = (await import("../db")).getDb().db;
  auth = (await import("../auth")).auth;
});

let next = 0;
/** A real user, created the way the app creates one, so no test imports the schema. */
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
  // SAFETY: a 200 from POST /sign-up/email always carries `{ user: { id } }`.
  return ((await response.json()) as { user: { id: string } }).user.id;
};

describe("rulesFor", () => {
  test("seeds the built-in merchants the first time, and only the first time", async () => {
    const userId = await makeUser();
    const seeded = rulesFor(db, userId);
    expect(seeded.length).toBeGreaterThan(50);
    expect(seeded.every((rule) => rule.source === "seed")).toBe(true);

    // A rule the owner deletes must stay deleted; re-seeding would undo them.
    removeRule(db, userId, "LIDL");
    expect(rulesFor(db, userId).some((rule) => rule.pattern === "LIDL")).toBe(false);
  });

  test("keeps one user's rules out of another's", async () => {
    const mine = await makeUser();
    const theirs = await makeUser();
    addRules(db, mine, [{ pattern: "PIENI PUOTI", category: "ruoka" }], "user");

    expect(rulesFor(db, theirs).some((rule) => rule.pattern === "PIENI PUOTI")).toBe(false);
  });
});

describe("matchRule", () => {
  const rules = [
    { pattern: "PRISMA", category: "ruoka" as const, source: "seed" as const },
    { pattern: "RAVINTOLA PRISMA", category: "ravintolat" as const, source: "user" as const },
  ];

  test("the most specific pattern wins, not the first one stored", () => {
    // Rules arrive from three sources in no fixed order, so "first match" would
    // make the answer depend on insertion order.
    expect(matchRule("PKORTTIMAKSU — RAVINTOLA PRISMA", rules)?.category).toBe("ravintolat");
    expect(matchRule("PKORTTIMAKSU — PRISMA SALO", rules)?.category).toBe("ruoka");
  });

  test("no rule means no guess", () => {
    expect(matchRule("PKORTTIMAKSU — TUNTEMATON", rules)).toBeNull();
    expect(categoriseWith("PKORTTIMAKSU — TUNTEMATON", rules)).toBe("muu");
  });
});

describe("addRules", () => {
  test("refuses a category that does not exist", async () => {
    const userId = await makeUser();
    const { added, rejected } = addRules(
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
    expect(addRules(db, userId, [{ pattern: "OY", category: "ruoka" }], "ai").added).toEqual([]);
  });

  test("leaves an existing rule alone rather than replacing it", async () => {
    const userId = await makeUser();
    addRules(db, userId, [{ pattern: "PIENI PUOTI", category: "vapaa-aika" }], "user");
    addRules(db, userId, [{ pattern: "pieni puoti", category: "ruoka" }], "ai");

    expect(categoriseWith("PIENI PUOTI OY", rulesFor(db, userId))).toBe("vapaa-aika");
  });

  test("records who decided, so a guess can be told from an answer", async () => {
    const userId = await makeUser();
    addRules(db, userId, [{ pattern: "PIENI PUOTI", category: "ruoka" }], "ai");
    const stored = rulesFor(db, userId).find((rule) => rule.pattern === "PIENI PUOTI");

    expect(stored?.source).toBe("ai");
  });
});

describe("removeRule", () => {
  test("removes only the named rule, and says when there was none", async () => {
    const userId = await makeUser();
    const before = rulesFor(db, userId).length;

    expect(removeRule(db, userId, "lidl")).toBe(true);
    expect(removeRule(db, userId, "EI TÄLLAISTA")).toBe(false);
    expect(rulesFor(db, userId)).toHaveLength(before - 1);
  });
});

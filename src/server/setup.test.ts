import { count } from "drizzle-orm";
import { beforeAll, describe, expect, test } from "vitest";
import { db } from "./db/index.ts";
import { testDb } from "./db/test-db.ts";
import { user } from "./db/schema.ts";

// This file exercises the first-run functions against the SAME shared, migrated
// in-memory database every other server test file uses (see
// ../test-setup.ts's comment -- this file must NOT call
// resetDbHandleForTests(), set DATABASE_PATH, or call the shared database
// itself). By the time any test below runs, other test files (auth.test.ts,
// accounts.test.ts, ...) may already have created users in that shared
// database, in an order this file does not control -- so the tests here
// that need a database with a KNOWN user (the "already set up" tests)
// create their own via a real Better Auth sign-up first, and never assert
// the negative ("hasUsers is false") against the shared database.
//
// The "zero users" scenarios -- the empty-instance form actually working,
// and the concurrent-request race -- are exactly the cases the shared
// database cannot exercise (it may already be non-empty by the time this
// file runs, order-dependent). Those call `testDb()`, which empties every
// table, rather than the child process they used to need.

let auth: ReturnType<(typeof import("./auth.ts"))["getAuth"]>;
let hasAnyUser: (typeof import("./setup.ts"))["hasAnyUser"];
let createFirstUser: (typeof import("./setup.ts"))["createFirstUser"];
let CreateFirstUser: (typeof import("./setup.ts"))["CreateFirstUser"];
let insertCredentialUser: (typeof import("./setup.ts"))["_internal"]["insertCredentialUser"];

beforeAll(async () => {
  const authModule = await import("./auth.ts");
  const setupModule = await import("./setup.ts");
  auth = authModule.getAuth();
  ({ hasAnyUser, createFirstUser, CreateFirstUser } = setupModule);
  insertCredentialUser = setupModule._internal.insertCredentialUser;
});

/** Better Auth's own password hashing, which is what setup.ts writes with. */
const hashPassword = async (password: string): Promise<string> =>
  (await auth.$context).password.hash(password);

const signUp = async (email: string): Promise<void> => {
  const response = await auth.handler(
    new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Test User", email, password: "correct horse battery staple" }),
    }),
  );
  if (response.status !== 200) throw new Error(`sign-up failed with status ${response.status}`);
};

const userCount = async (): Promise<number> => {
  const row = await db.select({ n: count() }).from(user).get();
  // `count()` over the whole table always returns a row, but saying so as a
  // check rather than an assertion means a driver that ever stops doing it
  // fails here with a sentence instead of somewhere else with a TypeError.
  if (row === undefined) throw new Error("count() returned no row");
  return row.n;
};

describe("hasAnyUser", () => {
  test("is callable with no session at all and reveals nothing beyond hasUsers", async () => {
    await signUp(`get-status-${crypto.randomUUID()}@example.com`);
    const state = { hasUsers: await hasAnyUser() };
    // Once any user exists (guaranteed true here, this file just created
    // one), the answer is EXACTLY { hasUsers: true } -- no count, no email,
    // no name, nothing else. What the screen may not learn, it is not told.
    expect(state).toEqual({ hasUsers: true });
  });
});

describe("insertCredentialUser (the row-writing half of createFirstUser)", () => {
  // Each of these empties the database first: the "exactly one owner" guard
  // now lives inside insertCredentialUser as a conditional insert, so a
  // non-empty table would make it write nothing.
  //
  // What matters here is row-shape correctness: does the account this writes
  // actually authenticate through Better Auth's real, unmodified sign-in
  // flow? Checked with a genuine hash and a genuine `auth.handler` sign-in
  // call, not by asserting the row shape matches what we believe it expects.
  test("writes a user + account row pair that Better Auth's own sign-in flow accepts", async () => {
    await testDb();
    const email = `insert-credential-${crypto.randomUUID()}@example.com`;
    const password = "correct horse battery staple";
    const passwordHash = await hashPassword(password);

    const created = await insertCredentialUser({ name: "Rivi", email, password }, passwordHash);
    expect(created).toEqual({ id: expect.any(String), email, name: "Rivi" });

    const signInResponse = await auth.handler(
      new Request("http://localhost/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      }),
    );
    expect(signInResponse.status).toBe(200);
    expect(signInResponse.headers.getSetCookie().some((c) => c.includes("session_token"))).toBe(
      true,
    );

    const wrongPasswordResponse = await auth.handler(
      new Request("http://localhost/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: "not the right password" }),
      }),
    );
    expect(wrongPasswordResponse.status).not.toBe(200);
  });

  test("lowercases the stored email, mirroring Better Auth's own sign-up normalisation", async () => {
    await testDb();
    const passwordHash = await hashPassword("correct horse battery staple");
    const mixedCaseEmail = `Mixed-Case-${crypto.randomUUID()}@Example.com`;

    const created = await insertCredentialUser(
      { name: "X", email: mixedCaseEmail, password: "correct horse battery staple" },
      passwordHash,
    );

    expect(created.email).toBe(mixedCaseEmail.toLowerCase());
  });
});

describe("createFirstUser", () => {
  test("refuses to create a second user once one already exists, and creates no row", async () => {
    await signUp(`already-set-up-${crypto.randomUUID()}@example.com`);
    const before = await userCount();

    await expect(
      createFirstUser({
        name: "Toinen käyttäjä",
        email: `refused-${crypto.randomUUID()}@example.com`,
        password: "correct horse battery staple",
      }),
    ).rejects.toThrow("Tili on jo luotu");
    expect(await userCount()).toBe(before);
  });

  test("refuses an invalid body, naming every field that is wrong", async () => {
    // The schema is the refusal now: it is the server function's validator, so
    // asserting on it is asserting on what a caller actually hits.
    const result = CreateFirstUser.safeParse({
      name: "",
      email: "not-an-email",
      password: "short",
    });
    expect(result.success).toBe(false);
    const fields = result.success ? [] : result.error.issues.map((issue) => String(issue.path[0]));
    expect(fields.sort()).toEqual(["email", "name", "password"]);
  });
});

// --- Zero-user scenarios: `testDb()` empties every table, which is what these
// need. They used to run in a child process because an empty database meant a
// second SQLite file; a D1 binding cannot be handed to one, and no longer
// needs to be.

describe("the first-run flow end-to-end, against a genuinely empty database", () => {
  test("reports no users, allows creating exactly one, then refuses a second -- and the created account can sign in", async () => {
    await testDb();

    expect(await hasAnyUser()).toBe(false);

    const created = await createFirstUser({
      name: "Omistaja",
      email: "owner@example.com",
      password: "correct horse battery staple",
    });
    expect(created).toEqual({
      id: expect.any(String),
      email: "owner@example.com",
      name: "Omistaja",
    });
    expect(await hasAnyUser()).toBe(true);

    await expect(
      createFirstUser({
        name: "Toinen",
        email: "second@example.com",
        password: "correct horse battery staple",
      }),
    ).rejects.toThrow();

    const signIn = await auth.handler(
      new Request("http://localhost/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "owner@example.com",
          password: "correct horse battery staple",
        }),
      }),
    );
    expect(signIn.status).toBe(200);
    expect(signIn.headers.getSetCookie().some((c) => c.includes("session_token"))).toBe(true);
  });

  test("two concurrent creation requests against an empty database: exactly one succeeds", async () => {
    await testDb();

    const post = (email: string) =>
      createFirstUser({ name: "Kilpailija", email, password: "correct horse battery staple" })
        .then(() => "created")
        .catch(() => "refused");

    // Exactly one wins. The other is refused, not queued behind it and not
    // allowed through: two owners of one household ledger is the one outcome
    // this guard exists to prevent. The guard is the conditional insert plus
    // the foreign key in insertCredentialUser, so it holds here even though
    // both calls interleave at their awaits.
    const outcomes = await Promise.all([post("racer-a@example.com"), post("racer-b@example.com")]);
    expect(outcomes.sort()).toEqual(["created", "refused"]);
  });
});

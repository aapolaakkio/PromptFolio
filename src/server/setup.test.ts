import { spawnSync } from "node:child_process";
import { count } from "drizzle-orm";
import { beforeAll, describe, expect, test } from "vitest";
import { getDb } from "./db/index.ts";
import { user } from "./db/schema.ts";

// This file exercises the first-run functions against the SAME shared, migrated
// in-memory database every other server test file uses (see
// ../test-setup.ts's comment -- this file must NOT call
// resetDbHandleForTests(), set DATABASE_PATH, or call getDb()/migrate()
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
// file runs, order-dependent). Those run in a genuine child process
// against its own fresh `:memory:` database instead, mirroring
// auth.test.ts's two child-process tests for the same reason.

let auth: (typeof import("./auth.ts"))["auth"];
let hasAnyUser: (typeof import("./setup.ts"))["hasAnyUser"];
let createFirstUser: (typeof import("./setup.ts"))["createFirstUser"];
let CreateFirstUser: (typeof import("./setup.ts"))["CreateFirstUser"];
let insertCredentialUser: (typeof import("./setup.ts"))["_internal"]["insertCredentialUser"];

beforeAll(async () => {
  const authModule = await import("./auth.ts");
  const setupModule = await import("./setup.ts");
  auth = authModule.auth;
  ({ hasAnyUser, createFirstUser, CreateFirstUser } = setupModule);
  insertCredentialUser = setupModule._internal.insertCredentialUser;
});

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

const userCount = (): number => {
  const { db } = getDb();
  // SAFETY: `count()` over the whole table always returns exactly one row.
  return db.select({ n: count() }).from(user).get()!.n;
};

describe("hasAnyUser", () => {
  test("is callable with no session at all and reveals nothing beyond hasUsers", async () => {
    await signUp(`get-status-${crypto.randomUUID()}@example.com`);
    const state = { hasUsers: hasAnyUser() };
    // Once any user exists (guaranteed true here, this file just created
    // one), the answer is EXACTLY { hasUsers: true } -- no count, no email,
    // no name, nothing else. What the screen may not learn, it is not told.
    expect(state).toEqual({ hasUsers: true });
  });
});

describe("insertCredentialUser (the row-writing half of createFirstUser)", () => {
  // Runs against the shared database directly, bypassing the "does a
  // user already exist" guard on purpose -- see insertCredentialUser's
  // own comment in setup.ts for why that's fine to test in isolation.
  // What matters here is row-shape correctness: does the account this
  // writes actually authenticate through Better Auth's real, unmodified
  // sign-in flow? This is checked with a genuine `Bun.password` hash and
  // a genuine `auth.handler` sign-in call, not by asserting the row
  // shape matches what we believe Better Auth expects.
  test("writes a user + account row pair that Better Auth's own sign-in flow accepts", async () => {
    const { hashPassword } = await import("./password.ts");
    const email = `insert-credential-${crypto.randomUUID()}@example.com`;
    const password = "correct horse battery staple";
    const passwordHash = await hashPassword(password);

    const created = insertCredentialUser({ name: "Rivi", email, password }, passwordHash);
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
    const { hashPassword } = await import("./password.ts");
    const passwordHash = await hashPassword("correct horse battery staple");
    const mixedCaseEmail = `Mixed-Case-${crypto.randomUUID()}@Example.com`;

    const created = insertCredentialUser(
      { name: "X", email: mixedCaseEmail, password: "correct horse battery staple" },
      passwordHash,
    );

    expect(created.email).toBe(mixedCaseEmail.toLowerCase());
  });
});

describe("createFirstUser", () => {
  test("refuses to create a second user once one already exists, and creates no row", async () => {
    await signUp(`already-set-up-${crypto.randomUUID()}@example.com`);
    const before = userCount();

    await expect(
      createFirstUser({
        name: "Toinen käyttäjä",
        email: `refused-${crypto.randomUUID()}@example.com`,
        password: "correct horse battery staple",
      }),
    ).rejects.toThrow("Tili on jo luotu");
    expect(userCount()).toBe(before);
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
    const fields = result.success ? [] : result.error.issues.map((issue) => issue.path[0]);
    expect(fields.sort()).toEqual(["email", "name", "password"]);
  });
});

// --- Zero-user scenarios: need a fresh, genuinely empty database, so they
// run in a real child process rather than against this file's shared one.
// Mirrors auth.test.ts's "sign-up is rejected end-to-end..." and "the
// process refuses to boot..." tests.

const CHILD_ENV = {
  ...process.env,
  DATABASE_PATH: ":memory:",
  BETTER_AUTH_SECRET: "test-secret-at-least-32-characters-long",
};

describe("the first-run flow end-to-end, against a genuinely empty database", () => {
  test("reports no users, allows creating exactly one, then refuses a second -- and the created account can sign in", () => {
    const setupPath = new URL("./setup.ts", import.meta.url).pathname;
    const authPath = new URL("./auth.ts", import.meta.url).pathname;
    const dbPath = new URL("./db/index.ts", import.meta.url).pathname;
    const script = `
const { getDb, migrate } = await import(${JSON.stringify(dbPath)});
migrate(getDb().db);
const { createFirstUser, hasAnyUser } = await import(${JSON.stringify(setupPath)});
const { auth } = await import(${JSON.stringify(authPath)});

const beforeBody = { hasUsers: hasAnyUser() };

const createdBody = await createFirstUser({ name: "Omistaja", email: "owner@example.com", password: "correct horse battery staple" });

const afterBody = { hasUsers: hasAnyUser() };

let secondRefused = false;
try {
  await createFirstUser({ name: "Toinen", email: "second@example.com", password: "correct horse battery staple" });
} catch {
  secondRefused = true;
}

const signInResponse = await auth.handler(
  new Request("http://localhost/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "owner@example.com", password: "correct horse battery staple" }),
  }),
);
const signedIn = signInResponse.headers.getSetCookie().some((c) => c.includes("session_token"));

console.log(JSON.stringify({
  beforeBody,
  createdBody,
  afterBody,
  secondRefused,
  signInStatus: signInResponse.status,
  signedIn,
}));
`;

    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf-8",
      cwd: import.meta.dirname,
      env: CHILD_ENV,
    });
    expect(result.status).toBe(0);
    // SAFETY: the child script above unconditionally prints exactly one
    // JSON line as its only stdout output, or the process would have
    // exited non-zero and failed the assertion above instead.
    const parsed = JSON.parse(result.stdout.trim()) as {
      beforeBody: { hasUsers: boolean };
      createdBody: { id: string; email: string; name: string };
      afterBody: { hasUsers: boolean };
      secondRefused: boolean;
      signInStatus: number;
      signedIn: boolean;
    };

    expect(parsed.beforeBody).toEqual({ hasUsers: false });
    expect(parsed.createdBody).toEqual({
      id: expect.any(String),
      email: "owner@example.com",
      name: "Omistaja",
    });
    expect(parsed.afterBody).toEqual({ hasUsers: true });
    expect(parsed.secondRefused).toBe(true);
    expect(parsed.signInStatus).toBe(200);
    expect(parsed.signedIn).toBe(true);
  });

  test("two concurrent creation requests against an empty database: exactly one succeeds", () => {
    const setupPath = new URL("./setup.ts", import.meta.url).pathname;
    const dbPath = new URL("./db/index.ts", import.meta.url).pathname;
    const script = `
const { getDb, migrate } = await import(${JSON.stringify(dbPath)});
migrate(getDb().db);
const { createFirstUser } = await import(${JSON.stringify(setupPath)});

const post = (email) =>
  createFirstUser({ name: "Kilpailija", email, password: "correct horse battery staple" })
    .then(() => "created")
    .catch(() => "refused");

const outcomes = await Promise.all([post("racer-a@example.com"), post("racer-b@example.com")]);
console.log(JSON.stringify({ outcomes: outcomes.sort() }));
`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf-8",
      cwd: import.meta.dirname,
      env: CHILD_ENV,
    });
    expect(result.status).toBe(0);
    // SAFETY: the child script above unconditionally prints exactly one
    // JSON line shaped `{ outcomes }` as its only stdout output, or the
    // process would have exited non-zero and failed the assertion above.
    const parsed = JSON.parse(result.stdout.trim()) as { outcomes: string[] };
    // Exactly one request creates the account (201), the other is refused
    // (403) -- never two 201s. This is the race the module comment on
    // createFirstUser explains.
    // Exactly one wins the race. The other is refused, not queued behind it
    // and not allowed through: two owners of one household ledger is the one
    // outcome this guard exists to prevent.
    expect(parsed.outcomes).toEqual(["created", "refused"]);
  });
});

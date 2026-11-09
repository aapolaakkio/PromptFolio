import { count } from "drizzle-orm";
import { beforeAll, describe, expect, test } from "vitest";
import { db } from "./db/index.ts";
import { testDb } from "./db/test-db.ts";
import { user } from "./db/schema.ts";

// Uses the shared migrated in-memory database (never reset it here). Other files may already have created users, so "already set up" tests create their own via a real sign-up and never assert hasUsers is false there.
// Zero-user scenarios (empty-instance form, concurrent race) call `testDb()`, which empties every table.

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
  // `count()` always returns a row; checking it gives a readable failure if a driver ever stops.
  if (row === undefined) throw new Error("count() returned no row");
  return row.n;
};

describe("hasAnyUser", () => {
  test("is callable with no session at all and reveals nothing beyond hasUsers", async () => {
    await signUp(`get-status-${crypto.randomUUID()}@example.com`);
    const state = { hasUsers: await hasAnyUser() };
    // With any user present the answer is exactly { hasUsers: true }: no count, email or name.
    expect(state).toEqual({ hasUsers: true });
  });
});

describe("insertCredentialUser (the row-writing half of createFirstUser)", () => {
  // Each empties the database first: the "exactly one owner" guard is a conditional insert, so a non-empty table writes nothing.
  // What matters is row shape: the account must authenticate through Better Auth's real sign-in, checked with a genuine hash and `auth.handler`.
  test("writes a user + account row pair that Better Auth's own sign-in flow accepts", async () => {
    await testDb();
    const email = `insert-credential-${crypto.randomUUID()}@example.com`;
    const password = "correct horse battery staple";
    const passwordHash = await hashPassword(password);

    const created = await insertCredentialUser({ name: "Row", email, password }, passwordHash);
    expect(created).toEqual({ id: expect.any(String), email, name: "Row" });

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
        name: "Second user",
        email: `refused-${crypto.randomUUID()}@example.com`,
        password: "correct horse battery staple",
      }),
    ).rejects.toThrow("An account has already been created");
    expect(await userCount()).toBe(before);
  });

  test("refuses an invalid body, naming every field that is wrong", async () => {
    // The schema is the server function's validator, so this is what a caller hits.
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

// --- Zero-user scenarios: `testDb()` empties every table ---

describe("the first-run flow end-to-end, against a genuinely empty database", () => {
  test("reports no users, allows creating exactly one, then refuses a second -- and the created account can sign in", async () => {
    await testDb();

    expect(await hasAnyUser()).toBe(false);

    const created = await createFirstUser({
      name: "Owner",
      email: "owner@example.com",
      password: "correct horse battery staple",
    });
    expect(created).toEqual({
      id: expect.any(String),
      email: "owner@example.com",
      name: "Owner",
    });
    expect(await hasAnyUser()).toBe(true);

    await expect(
      createFirstUser({
        name: "Other",
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
      createFirstUser({ name: "Competitor", email, password: "correct horse battery staple" })
        .then(() => "created")
        .catch(() => "refused");

    // Exactly one wins; the other is refused, neither queued nor let through (two owners of one ledger is what the guard prevents). The conditional insert plus the foreign key hold even with both calls interleaved.
    const outcomes = await Promise.all([post("racer-a@example.com"), post("racer-b@example.com")]);
    expect(outcomes.sort()).toEqual(["created", "refused"]);
  });
});

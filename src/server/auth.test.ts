import { beforeAll, expect, test } from "bun:test";
import { getDb, migrate, resetDbHandleForTests } from "./db";
import { HttpError } from "./errors";
import { hashPassword, verifyPassword } from "./password";

// --- Shared, migrated in-memory database + a single Better Auth instance ---
//
// auth.ts calls getDb() at module scope, and getDb() memoises a shared
// handle for the lifetime of the process (see db/index.ts). To hand auth.ts
// a migrated in-memory database instead of the real on-disk one, the handle
// must be reset, pointed at ":memory:", and migrated *before* anything
// imports auth.ts or auth-guard.ts. A static top-level `import` would run
// too early (import statements are hoisted above this file's own top-level
// code), so auth.ts/auth-guard.ts are imported dynamically from beforeAll
// instead, once the database and required env vars are ready.
//
// ALLOW_SIGNUP is set to 'true' before that import so this file's one
// `auth` instance permits sign-up, which lets tests create a real,
// correctly-issued session to exercise requireUser's happy path.
let auth: (typeof import("./auth"))["auth"];
let resolveAuthSecret: (typeof import("./auth"))["resolveAuthSecret"];
let resolveDisableSignUp: (typeof import("./auth"))["resolveDisableSignUp"];
let requireUser: (typeof import("./auth-guard"))["requireUser"];

const TEST_SECRET = "test-secret-at-least-32-characters-long";

beforeAll(async () => {
  resetDbHandleForTests();
  Bun.env.DATABASE_PATH = ":memory:";
  Bun.env.BETTER_AUTH_SECRET = TEST_SECRET;
  Bun.env.ALLOW_SIGNUP = "true";

  const { db } = getDb();
  migrate(db);

  const authModule = await import("./auth");
  const authGuardModule = await import("./auth-guard");
  auth = authModule.auth;
  resolveAuthSecret = authModule.resolveAuthSecret;
  resolveDisableSignUp = authModule.resolveDisableSignUp;
  requireUser = authGuardModule.requireUser;
});

/** Extracts the `name=value` prefix of the session cookie from a Set-Cookie header. */
const sessionCookieFrom = (response: Response): string => {
  const setCookie = response.headers.getSetCookie().find((c) => c.includes("session_token"));
  if (!setCookie) throw new Error("Response carried no session_token cookie");
  const nameValue = setCookie.split(";")[0];
  if (!nameValue) throw new Error("Malformed Set-Cookie header");
  return nameValue;
};

const signUp = (email: string, password: string): Promise<Response> =>
  auth.handler(
    new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Test User", email, password }),
    }),
  );

// --- Password hashing (src/server/password.ts) ---

test("hashes with argon2id and verifies", async () => {
  const hash = await hashPassword("correct horse battery staple");
  expect(hash).toStartWith("$argon2id$");
  expect(await verifyPassword({ password: "correct horse battery staple", hash })).toBe(true);
  expect(await verifyPassword({ password: "wrong", hash })).toBe(false);
});

test("the same password hashes differently each time", async () => {
  const a = await hashPassword("same");
  const b = await hashPassword("same");
  expect(a).not.toBe(b);
});

// --- requireUser (src/server/auth-guard.ts) ---

test("requireUser rejects a request with no session cookie", async () => {
  const request = new Request("http://localhost/api/holdings");
  await expect(requireUser(request)).rejects.toThrow(HttpError);
  await expect(requireUser(request)).rejects.toMatchObject({ status: 401 });
});

test("requireUser rejects a request with a garbage session cookie", async () => {
  const request = new Request("http://localhost/api/holdings", {
    headers: { cookie: "better-auth.session_token=not-a-real-token" },
  });
  await expect(requireUser(request)).rejects.toMatchObject({ status: 401 });
});

test("requireUser resolves the authenticated user for a valid session", async () => {
  const email = `valid-session-${crypto.randomUUID()}@example.com`;
  const signUpResponse = await signUp(email, "correct horse battery staple");
  expect(signUpResponse.status).toBe(200);
  // SAFETY: a 200 from POST /sign-up/email is Better Auth's documented
  // success response, which always carries `{ token, user: { id, ... } }`.
  const body = (await signUpResponse.json()) as { user: { id: string } };
  const cookie = sessionCookieFrom(signUpResponse);

  const protectedRequest = new Request("http://localhost/api/holdings", {
    headers: { cookie },
  });
  const result = await requireUser(protectedRequest);
  expect(result).toEqual({ userId: body.user.id });
});

// --- Error messages must not reveal whether an email address exists ---

test("sign-in gives the same error for an unknown email and a wrong password", async () => {
  const email = `known-user-${crypto.randomUUID()}@example.com`;
  await signUp(email, "correct horse battery staple");

  const signInAs = (candidateEmail: string, password: string) =>
    auth.handler(
      new Request("http://localhost/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: candidateEmail, password }),
      }),
    );

  const unknownEmailResponse = await signInAs(
    `nobody-${crypto.randomUUID()}@example.com`,
    "irrelevant",
  );
  const wrongPasswordResponse = await signInAs(email, "wrong password");

  expect(unknownEmailResponse.status).toBe(wrongPasswordResponse.status);
  expect(await unknownEmailResponse.json()).toEqual(await wrongPasswordResponse.json());
});

// --- Sign-up is closed by default ---

test("resolveDisableSignUp closes sign-up unless ALLOW_SIGNUP is exactly 'true'", () => {
  expect(resolveDisableSignUp({})).toBe(true);
  expect(resolveDisableSignUp({ ALLOW_SIGNUP: "false" })).toBe(true);
  expect(resolveDisableSignUp({ ALLOW_SIGNUP: "TRUE" })).toBe(true);
  expect(resolveDisableSignUp({ ALLOW_SIGNUP: "true" })).toBe(false);
});

// --- BETTER_AUTH_SECRET must be a real secret, or the process refuses to boot ---

test("resolveAuthSecret rejects a missing, empty, or too-short secret", () => {
  expect(() => resolveAuthSecret({})).toThrow(
    "BETTER_AUTH_SECRET must be set to at least 32 characters",
  );
  expect(() => resolveAuthSecret({ BETTER_AUTH_SECRET: "" })).toThrow();
  expect(() => resolveAuthSecret({ BETTER_AUTH_SECRET: "a".repeat(31) })).toThrow();
});

test("resolveAuthSecret accepts a secret at or above the 32-character minimum", () => {
  expect(resolveAuthSecret({ BETTER_AUTH_SECRET: "a".repeat(32) })).toBe("a".repeat(32));
  expect(resolveAuthSecret({ BETTER_AUTH_SECRET: TEST_SECRET })).toBe(TEST_SECRET);
});

test("the process refuses to boot when BETTER_AUTH_SECRET is missing", () => {
  const authPath = new URL("./auth.ts", import.meta.url).pathname;
  const envWithoutSecret = Object.fromEntries(
    Object.entries(Bun.env).filter(([key]) => key !== "BETTER_AUTH_SECRET"),
  );
  const envForChild = { ...envWithoutSecret, DATABASE_PATH: ":memory:" };

  const result = Bun.spawnSync({
    cmd: ["bun", "-e", `await import(${JSON.stringify(authPath)})`],
    cwd: import.meta.dir,
    env: envForChild,
  });

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain(
    "BETTER_AUTH_SECRET must be set to at least 32 characters",
  );
});

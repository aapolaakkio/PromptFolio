import { spawnSync } from "node:child_process";
import { beforeAll, expect, test } from "vitest";
import { HttpError } from "./errors.ts";
import { hashPassword, verifyPassword } from "./password.ts";

// --- Shared, migrated in-memory database + a single Better Auth instance ---
//
// auth.ts calls getDb() at module scope, and getDb() memoises a shared
// handle for the lifetime of the process (see db/index.ts). test-setup.ts
// (a vitest.config.ts `setupFiles` entry — see its own comment for the
// full story) has already pointed that handle at a migrated in-memory
// database before this file's own code runs, so this file must NOT call
// resetDbHandleForTests(): doing so would mint a second database that only
// *this* file's own dynamically-imported auth.ts would bind to (auth.ts is
// itself a process-wide ES module singleton — whichever code imports it
// first anywhere in the process wins for the rest of the run), desyncing
// it from every other test file's already-cached auth.ts. A static
// top-level `import` would run too early regardless (import statements are
// hoisted above this file's own top-level code), so auth.ts/auth-guard.ts
// are imported dynamically from beforeAll instead.
//
// ALLOW_SIGNUP is set to 'true' by test-setup.ts, which lets this file's
// one `auth` instance permit sign-up, so tests here can create a real,
// correctly-issued session to exercise requireUser's happy path.
let auth: (typeof import("./auth.ts"))["auth"];
let resolveAuthSecret: (typeof import("./auth.ts"))["resolveAuthSecret"];
let resolveDisableSignUp: (typeof import("./auth.ts"))["resolveDisableSignUp"];
let requireUser: (typeof import("./auth-guard.ts"))["requireUser"];

const TEST_SECRET = "test-secret-at-least-32-characters-long";

beforeAll(async () => {
  const authModule = await import("./auth.ts");
  const authGuardModule = await import("./auth-guard.ts");
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
  expect(hash.startsWith("$argon2id$")).toBe(true);
  expect(await verifyPassword({ password: "correct horse battery staple", hash })).toBe(true);
  expect(await verifyPassword({ password: "wrong", hash })).toBe(false);
});

test("the same password hashes differently each time", async () => {
  const a = await hashPassword("same");
  const b = await hashPassword("same");
  expect(a).not.toBe(b);
});

test("verifyPassword fails closed (returns false, doesn't throw) on a malformed stored hash", async () => {
  // Bun.password.verify throws on a hash it can't parse (unsupported
  // algorithm, invalid encoding). A corrupted/hand-edited row must not
  // crash sign-in; it must be treated the same as a wrong password.
  expect(await verifyPassword({ password: "x", hash: "not-a-valid-hash-at-all" })).toBe(false);
  expect(
    await verifyPassword({
      password: "x",
      hash: "$2b$10$notreallybcryptgarbagegarbagegarbagegarba",
    }),
  ).toBe(false);
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

test("sign-up is rejected end-to-end when ALLOW_SIGNUP is not set", () => {
  // This is the control that stops an anonymous stranger who reaches the
  // URL from creating an account on an application holding financial
  // records. resolveDisableSignUp's unit tests above prove the boolean is
  // computed correctly; this proves an actual /sign-up/email request is
  // actually refused. It runs in a real child process (not a second
  // same-process module instance via a cache-busted dynamic import)
  // because a same-process second `auth` instance made Bun's coverage
  // instrumentation misattribute hits on this file - see task-8-report.md.
  const authPath = new URL("./auth.ts", import.meta.url).pathname;
  const envWithoutAllowSignup = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key !== "ALLOW_SIGNUP"),
  );
  const envForChild = { ...envWithoutAllowSignup, DATABASE_PATH: ":memory:" };
  const payload = {
    name: "Nope",
    email: "blocked@example.com",
    password: "correct horse battery staple",
  };

  const script = `
const { auth } = await import(${JSON.stringify(authPath)});
const response = await auth.handler(
  new Request("http://localhost/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(${JSON.stringify(payload)}),
  }),
);
const body = await response.json();
console.log(JSON.stringify({ status: response.status, body }));
`;

  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf-8",
    cwd: import.meta.dirname,
    env: envForChild,
  });

  expect(result.status).toBe(0);
  // SAFETY: the child script above unconditionally prints exactly
  // `{ status, body }` as its only stdout line, or the process would have
  // exited non-zero and failed the assertion above instead.
  const parsed = JSON.parse(result.stdout.trim()) as {
    status: number;
    body: { code?: string };
  };
  expect(parsed.status).not.toBe(200);
  expect(parsed.body.code).toBe("EMAIL_PASSWORD_SIGN_UP_DISABLED");
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
    Object.entries(process.env).filter(([key]) => key !== "BETTER_AUTH_SECRET"),
  );
  const envForChild = { ...envWithoutSecret, DATABASE_PATH: ":memory:" };

  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `await import(${JSON.stringify(authPath)})`],
    {
      encoding: "utf-8",
      cwd: import.meta.dirname,
      env: envForChild,
    },
  );

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("BETTER_AUTH_SECRET must be set to at least 32 characters");
});

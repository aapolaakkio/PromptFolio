import { env } from "cloudflare:workers";
import { beforeAll, expect, test } from "vitest";

// --- Shared migrated in-memory database + a single Better Auth instance ---
// test-setup.ts has pinned the shared handle, so never call resetDbHandleForTests() here (it would desync this file's auth.ts
// from every other file's: auth.ts is a process-wide singleton). Import auth.ts dynamically from beforeAll,
// since static imports are hoisted above setup. test-setup.ts sets ALLOW_SIGNUP to 'true' so tests can create real sessions.
let auth: ReturnType<(typeof import("./auth.ts"))["getAuth"]>;
let resolveAuthSecret: (typeof import("./auth.ts"))["resolveAuthSecret"];
let resolveDisableSignUp: (typeof import("./auth.ts"))["resolveDisableSignUp"];

const TEST_SECRET = "test-secret-at-least-32-characters-long";

beforeAll(async () => {
  const authModule = await import("./auth.ts");
  auth = authModule.getAuth();
  resolveAuthSecret = authModule.resolveAuthSecret;
  resolveDisableSignUp = authModule.resolveDisableSignUp;
});

const signUp = (email: string, password: string): Promise<Response> =>
  auth.handler(
    new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Test User", email, password }),
    }),
  );

// Hashing is Better Auth's own scrypt (workerd cannot load argon2), so it is not tested here; that an account this app writes can sign in is covered in setup.test.ts.

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

test("sign-up is rejected end-to-end when ALLOW_SIGNUP is not set", async () => {
  // Proves a real /sign-up/email request is refused (resolveDisableSignUp's unit tests only prove the boolean). `getAuth()` reads config once, so the binding is changed and the instance dropped.
  const authModule = await import("./auth.ts");
  const previous = env.ALLOW_SIGNUP;
  env.ALLOW_SIGNUP = "false";
  authModule._resetAuthForTests();
  try {
    const response = await authModule.getAuth().handler(
      new Request("http://localhost/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Nope",
          email: `blocked-${crypto.randomUUID()}@example.com`,
          password: "correct horse battery staple",
        }),
      }),
    );
    expect(response.status).not.toBe(200);
    // SAFETY: Better Auth's refusal body carries a `code`; anything else fails the assertion.
    const body = (await response.json()) as { code?: string };
    expect(body.code).toBe("EMAIL_PASSWORD_SIGN_UP_DISABLED");
  } finally {
    env.ALLOW_SIGNUP = previous;
    // Later tests share the instance, so restore the expected one.
    authModule._resetAuthForTests();
    auth = authModule.getAuth();
  }
});

// --- BETTER_AUTH_SECRET must be a real secret, or the process refuses to boot ---

test("resolveAuthSecret rejects a missing, empty, or too-short secret", async () => {
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

test("the server refuses to serve when BETTER_AUTH_SECRET is missing", async () => {
  // `getAuth()` throws at the first request (the instance is built on first use), not at startup.
  const authModule = await import("./auth.ts");
  const previous = env.BETTER_AUTH_SECRET;
  env.BETTER_AUTH_SECRET = "";
  authModule._resetAuthForTests();
  try {
    expect(() => authModule.getAuth()).toThrow(
      "BETTER_AUTH_SECRET must be set to at least 32 characters",
    );
  } finally {
    env.BETTER_AUTH_SECRET = previous;
    authModule._resetAuthForTests();
    auth = authModule.getAuth();
  }
});

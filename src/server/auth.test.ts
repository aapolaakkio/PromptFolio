import { env } from "cloudflare:workers";
import { beforeAll, expect, test } from "vitest";
import { HttpError } from "./errors.ts";

// --- Shared, migrated in-memory database + a single Better Auth instance ---
//
// auth.ts reads the database at module scope, and the database module exports a shared
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
let auth: ReturnType<(typeof import("./auth.ts"))["getAuth"]>;
let resolveAuthSecret: (typeof import("./auth.ts"))["resolveAuthSecret"];
let resolveDisableSignUp: (typeof import("./auth.ts"))["resolveDisableSignUp"];
let requireUser: (typeof import("./auth-guard.ts"))["requireUser"];

const TEST_SECRET = "test-secret-at-least-32-characters-long";

beforeAll(async () => {
  const authModule = await import("./auth.ts");
  const authGuardModule = await import("./auth-guard.ts");
  auth = authModule.getAuth();
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

// Password hashing had its own tests here, against src/server/password.ts's
// argon2 backend. Both are gone: workerd cannot load a native Rust binding, so
// hashing is Better Auth's own (scrypt) and testing it would be testing the
// library. What actually matters -- that an account this app writes can then
// sign in through the real handler -- is covered end-to-end in setup.test.ts.

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

test("sign-up is rejected end-to-end when ALLOW_SIGNUP is not set", async () => {
  // This is the control that stops an anonymous stranger who reaches the URL
  // from creating an account on an application holding financial records.
  // resolveDisableSignUp's unit tests above prove the boolean is computed
  // correctly; this proves an actual /sign-up/email request is actually
  // refused.
  //
  // It used to run in a child process, which a Worker binding cannot be handed
  // to. `getAuth()` reads its configuration once and remembers it, so the
  // binding is changed and the instance dropped instead.
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
    // SAFETY: Better Auth's documented refusal body for this route carries a
    // `code`; anything else fails the assertion rather than reading as a pass.
    const body = (await response.json()) as { code?: string };
    expect(body.code).toBe("EMAIL_PASSWORD_SIGN_UP_DISABLED");
  } finally {
    env.ALLOW_SIGNUP = previous;
    // Every later test in this process shares the instance, so it has to go
    // back to the one they expect.
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
  // The refusal moved with the instance: `auth` is built on first use now
  // rather than at import, because a Worker evaluates modules during a
  // request. So this is `getAuth()` throwing, not a process failing to boot --
  // the same refusal, at the first request instead of at startup.
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

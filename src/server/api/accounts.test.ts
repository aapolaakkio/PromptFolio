import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { getDb, migrate } from "../db";
import { HttpError, handle, json } from "../http";

// --- handle() / json() (src/server/http.ts) ---

test("wraps a handler result as JSON", async () => {
  const response = await handle(async () => json({ ok: true }))(new Request("http://x/"));
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(await response.json()).toEqual({ ok: true });
});

test("maps HttpError to its status and a Finnish message", async () => {
  const response = await handle(async () => {
    throw new HttpError(403, "Ei oikeuksia");
  })(new Request("http://x/"));
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: "Ei oikeuksia" });
});

test("maps a Zod failure to 400 with field detail", async () => {
  const schema = z.object({ name: z.string().min(1) });
  const response = await handle(async () => {
    schema.parse({ name: "" });
    return json({});
  })(new Request("http://x/"));
  expect(response.status).toBe(400);
  // SAFETY: handle()'s ZodError branch (asserted above via status 400)
  // always shapes its body as `{ error, fields: [{ path, message }] }`.
  const body = (await response.json()) as { error: string; fields: Array<{ path: string }> };
  expect(body.fields[0]!.path).toBe("name");
});

test("never leaks an unexpected error message to the client", async () => {
  const response = await handle(async () => {
    throw new Error("SELECT * FROM secrets failed");
  })(new Request("http://x/"));
  expect(response.status).toBe(500);
  expect(await response.text()).not.toContain("secrets");
});

// --- http.ts must not transitively import auth.ts or touch a database ---
//
// auth-guard.ts (and therefore auth.ts) opens a database connection and
// throws at import time when BETTER_AUTH_SECRET is missing. http.ts is
// meant to be usable by any route module without paying that cost, so
// HttpError is re-exported from errors.ts, not auth-guard.ts. Proved here
// in a real child process (not a same-process dynamic import) so module
// caching from earlier tests in this same process can't hide a transitive
// import: a child process that only imports http.ts, with no
// BETTER_AUTH_SECRET set and pointed at an empty cwd, must both exit 0 and
// create no database file on disk.
test("importing http.ts alone needs no BETTER_AUTH_SECRET and opens no database", () => {
  const httpPath = new URL("../http.ts", import.meta.url).pathname;
  const envWithoutSecret = Object.fromEntries(
    Object.entries(Bun.env).filter(
      ([key]) => key !== "BETTER_AUTH_SECRET" && key !== "DATABASE_PATH",
    ),
  );
  const scratchCwd = mkdtempSync(join(tmpdir(), "promptfolio-http-import-"));
  try {
    const result = Bun.spawnSync({
      cmd: ["bun", "-e", `await import(${JSON.stringify(httpPath)}); console.log("ok")`],
      cwd: scratchCwd,
      env: envWithoutSecret,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe("ok");
    expect(existsSync(join(scratchCwd, "data"))).toBe(false);
  } finally {
    rmSync(scratchCwd, { recursive: true, force: true });
  }
});

// --- accountRoutes / assertAccountOwned (src/server/api/accounts.ts) ---
//
// These need a real, migrated database and a real Better Auth session, so
// auth.ts and accounts.ts are imported dynamically from beforeAll (import
// statements are hoisted above this file's own top-level code, so a static
// import would run before the database below is ready) — mirroring
// src/server/auth.test.ts.
//
// Deliberately does NOT call resetDbHandleForTests(): auth.ts calls
// getDb() at module scope and is an ES module singleton for the lifetime
// of this `bun test` process — the *first* file to dynamically import it
// (this one, src/server/auth.test.ts, or a sibling in this directory)
// permanently binds it to whichever database was current at that moment.
// Resetting the shared handle here would desync this file's own
// database from that already-cached auth.ts if some other file happened
// to import it first, causing sign-up to write to one database while
// accountRoutes queries another (they'd fail with a foreign-key error
// that has nothing to do with the behaviour under test — this happened
// during development; see task-9-report.md). Every file in this
// situation uses the same DATABASE_PATH/BETTER_AUTH_SECRET/ALLOW_SIGNUP
// values and simply calls getDb() (which memoizes) + migrate() (which is
// idempotent), so whichever file runs first establishes the one shared
// database and every later file — and every module that reads it via
// getDb() at its own first import, including accounts.ts — converges on
// that same instance regardless of run order.

const TEST_SECRET = "test-secret-at-least-32-characters-long";

let auth: (typeof import("../auth"))["auth"];
let accountRoutes: (typeof import("./accounts"))["accountRoutes"];
let assertAccountOwned: (typeof import("./accounts"))["assertAccountOwned"];

beforeAll(async () => {
  Bun.env.DATABASE_PATH = ":memory:";
  Bun.env.BETTER_AUTH_SECRET = TEST_SECRET;
  Bun.env.ALLOW_SIGNUP = "true";

  const { db } = getDb();
  migrate(db);

  const authModule = await import("../auth");
  const accountsModule = await import("./accounts");
  auth = authModule.auth;
  accountRoutes = accountsModule.accountRoutes;
  assertAccountOwned = accountsModule.assertAccountOwned;
});

const sessionCookieFrom = (response: Response): string => {
  const setCookie = response.headers.getSetCookie().find((c) => c.includes("session_token"));
  if (!setCookie) throw new Error("Response carried no session_token cookie");
  const nameValue = setCookie.split(";")[0];
  if (!nameValue) throw new Error("Malformed Set-Cookie header");
  return nameValue;
};

const signUp = async (email: string): Promise<{ userId: string; cookie: string }> => {
  const response = await auth.handler(
    new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Test User", email, password: "correct horse battery staple" }),
    }),
  );
  if (response.status !== 200) throw new Error(`sign-up failed with status ${response.status}`);
  // SAFETY: a 200 from POST /sign-up/email is Better Auth's documented
  // success response, which always carries `{ token, user: { id, ... } }`.
  const body = (await response.json()) as { user: { id: string } };
  return { userId: body.user.id, cookie: sessionCookieFrom(response) };
};

describe("GET /api/accounts", () => {
  test("rejects a request with no session", async () => {
    const response = await accountRoutes["/api/accounts"].GET(new Request("http://x/api/accounts"));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Kirjautuminen vaaditaan" });
  });

  test("lists only the caller's own accounts", async () => {
    const owner = await signUp(`owner-${crypto.randomUUID()}@example.com`);
    const stranger = await signUp(`stranger-${crypto.randomUUID()}@example.com`);

    await accountRoutes["/api/accounts"].POST(
      new Request("http://x/api/accounts", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: owner.cookie },
        body: JSON.stringify({ name: "Nordnet AOT", broker: "nordnet" }),
      }),
    );
    await accountRoutes["/api/accounts"].POST(
      new Request("http://x/api/accounts", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: stranger.cookie },
        body: JSON.stringify({ name: "OP tili", broker: "op" }),
      }),
    );

    const response = await accountRoutes["/api/accounts"].GET(
      new Request("http://x/api/accounts", { headers: { cookie: owner.cookie } }),
    );
    expect(response.status).toBe(200);
    // SAFETY: a 200 from GET /api/accounts (asserted above) always returns
    // the accounts array shape accountRoutes' GET handler builds.
    const body = (await response.json()) as Array<{ name: string; userId: string }>;
    expect(body).toEqual([expect.objectContaining({ name: "Nordnet AOT", userId: owner.userId })]);
  });
});

describe("POST /api/accounts", () => {
  test("rejects a request with no session", async () => {
    const response = await accountRoutes["/api/accounts"].POST(
      new Request("http://x/api/accounts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "x", broker: "nordnet" }),
      }),
    );
    expect(response.status).toBe(401);
  });

  test("creates an account owned by the caller and defaults baseCurrency to EUR", async () => {
    const { cookie, userId } = await signUp(`creator-${crypto.randomUUID()}@example.com`);
    const response = await accountRoutes["/api/accounts"].POST(
      new Request("http://x/api/accounts", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ name: "Danske", broker: "danske" }),
      }),
    );
    expect(response.status).toBe(201);
    // SAFETY: a 201 from POST /api/accounts (asserted above) always returns
    // the inserted row, which carries every accounts column.
    const body = (await response.json()) as {
      id: number;
      name: string;
      userId: string;
      baseCurrency: string;
    };
    expect(body.name).toBe("Danske");
    expect(body.userId).toBe(userId);
    expect(body.baseCurrency).toBe("EUR");
  });

  test("rejects an invalid body with 400 field detail", async () => {
    const { cookie } = await signUp(`invalid-body-${crypto.randomUUID()}@example.com`);
    const response = await accountRoutes["/api/accounts"].POST(
      new Request("http://x/api/accounts", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ name: "", broker: "not-a-real-broker" }),
      }),
    );
    expect(response.status).toBe(400);
    // SAFETY: handle()'s ZodError branch (asserted above via status 400)
    // always shapes its body as `{ error, fields: [{ path, message }] }`.
    const body = (await response.json()) as { fields: Array<{ path: string }> };
    expect(body.fields.map((f) => f.path).sort()).toEqual(["broker", "name"]);
  });
});

describe("assertAccountOwned", () => {
  test("does not throw for an account owned by the given user", async () => {
    const { cookie, userId } = await signUp(`assert-owned-${crypto.randomUUID()}@example.com`);
    const createResponse = await accountRoutes["/api/accounts"].POST(
      new Request("http://x/api/accounts", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ name: "Spankki", broker: "spankki" }),
      }),
    );
    expect(createResponse.status).toBe(201);
    // SAFETY: a 201 from POST /api/accounts (asserted above) always
    // returns the inserted row, which carries an `id` column.
    const created = (await createResponse.json()) as { id: number };
    expect(() => assertAccountOwned(userId, created.id)).not.toThrow();
  });

  test("throws a 404 HttpError for an account owned by someone else", async () => {
    const owner = await signUp(`assert-other-owner-${crypto.randomUUID()}@example.com`);
    const stranger = await signUp(`assert-other-stranger-${crypto.randomUUID()}@example.com`);
    const createResponse = await accountRoutes["/api/accounts"].POST(
      new Request("http://x/api/accounts", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: owner.cookie },
        body: JSON.stringify({ name: "Nordnet ASA", broker: "nordnet" }),
      }),
    );
    expect(createResponse.status).toBe(201);
    // SAFETY: a 201 from POST /api/accounts (asserted above) always
    // returns the inserted row, which carries an `id` column.
    const created = (await createResponse.json()) as { id: number };
    expect(() => assertAccountOwned(stranger.userId, created.id)).toThrow(
      expect.objectContaining({ status: 404 }),
    );
  });

  test("throws a 404 HttpError for an account id that does not exist", () => {
    expect(() => assertAccountOwned("nobody", 999_999)).toThrow(
      expect.objectContaining({ status: 404 }),
    );
  });
});

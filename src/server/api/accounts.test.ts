import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
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
// This file must NOT call resetDbHandleForTests(), set DATABASE_PATH, or
// call getDb()/migrate() itself: ../test-setup.ts (a bunfig.toml
// `[test] preload` script, see its own comment for the full story) has
// already done all of that, deterministically, before this file's own
// code runs — regardless of file scheduling. auth.ts is a process-wide ES
// module singleton (whichever code imports it first anywhere in the
// process wins for the rest of the run), so this file simply trusts that
// the shared getDb() handle already points at a migrated in-memory
// database and dynamically imports auth.ts/accounts.ts, both of which
// bind to that same handle at their own first import. Duplicating that
// setup here (an earlier version of this file did) is exactly what caused
// a real foreign-key failure during Task 9's development when another
// file's independent reset desynced it from this one — see
// task-9-report.md's fix-up report.

let auth: (typeof import("../auth"))["auth"];
let accountRoutes: (typeof import("./accounts"))["accountRoutes"];
let assertAccountOwned: (typeof import("./accounts"))["assertAccountOwned"];

beforeAll(async () => {
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

  // §10a A1: the real portfolio holds SEK, never USD -- an account's base
  // currency must accept any real ISO 4217 code, not just EUR/USD.
  test("creates an account with an explicit non-EUR/USD ISO base currency (SEK)", async () => {
    const { cookie } = await signUp(`sek-account-${crypto.randomUUID()}@example.com`);
    const response = await accountRoutes["/api/accounts"].POST(
      new Request("http://x/api/accounts", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ name: "Avanza", broker: "other", baseCurrency: "SEK" }),
      }),
    );
    expect(response.status).toBe(201);
    // SAFETY: a 201 from POST /api/accounts (asserted above) always returns
    // the inserted row, which carries a baseCurrency.
    const body = (await response.json()) as { baseCurrency: string };
    expect(body.baseCurrency).toBe("SEK");
  });

  test("rejects a base currency not shaped like an ISO 4217 code with 400 field detail", async () => {
    const { cookie } = await signUp(`bad-currency-account-${crypto.randomUUID()}@example.com`);
    const response = await accountRoutes["/api/accounts"].POST(
      new Request("http://x/api/accounts", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ name: "x", broker: "other", baseCurrency: "12" }),
      }),
    );
    expect(response.status).toBe(400);
    // SAFETY: handle()'s ZodError branch (asserted above via status 400)
    // always shapes its body as `{ error, fields: [{ path, message }] }`.
    const body = (await response.json()) as { fields: Array<{ path: string }> };
    expect(body.fields.map((f) => f.path)).toContain("baseCurrency");
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

/** Creates an account and returns its id; this file otherwise posts inline. */
const createAccount = async (
  cookie: string,
  body: { name: string; broker: string },
): Promise<number> => {
  const response = await accountRoutes["/api/accounts"].POST(
    new Request("http://x/api/accounts", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(body),
    }),
  );
  expect(response.status).toBe(201);
  // SAFETY: a 201 from POST /api/accounts always returns the inserted row.
  return ((await response.json()) as { id: number }).id;
};

describe("PATCH /api/accounts/:id", () => {
  const rename = async (cookie: string, id: number, name: string): Promise<Response> =>
    accountRoutes["/api/accounts/:id"].PATCH(
      new Request(`http://x/api/accounts/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ name }),
      }),
    );

  test("rejects a request with no session", async () => {
    expect((await rename("", 1, "Uusi nimi")).status).toBe(401);
  });

  test("renames an account the caller owns", async () => {
    const { cookie } = await signUp(`rename-${crypto.randomUUID()}@example.com`);
    const id = await createAccount(cookie, { name: "Vanha nimi", broker: "nordnet" });

    const response = await rename(cookie, id, "Nordnet OST");
    expect(response.status).toBe(200);
    // SAFETY: a 200 from PATCH always returns the updated row.
    expect(((await response.json()) as { name: string }).name).toBe("Nordnet OST");
  });

  test("refuses an account belonging to someone else, as 404 rather than 403", async () => {
    const owner = await signUp(`rename-owner-${crypto.randomUUID()}@example.com`);
    const id = await createAccount(owner.cookie, { name: "Omistajan tili", broker: "op" });
    const stranger = await signUp(`rename-stranger-${crypto.randomUUID()}@example.com`);

    expect((await rename(stranger.cookie, id, "Kaapattu")).status).toBe(404);

    // And the name is untouched.
    const listed = await accountRoutes["/api/accounts"].GET(
      new Request("http://x/api/accounts", { headers: { cookie: owner.cookie } }),
    );
    // SAFETY: a 200 from GET /api/accounts always returns the owner's rows.
    const rows = (await listed.json()) as Array<{ id: number; name: string }>;
    expect(rows.find((row) => row.id === id)?.name).toBe("Omistajan tili");
  });

  test("refuses an empty name", async () => {
    const { cookie } = await signUp(`rename-empty-${crypto.randomUUID()}@example.com`);
    const id = await createAccount(cookie, { name: "Tili", broker: "op" });
    expect((await rename(cookie, id, "   ")).status).toBe(400);
  });

  // The broker and base currency are facts the stored transactions were already
  // interpreted under; changing either after rows exist would reinterpret them.
  test("cannot change the broker or the base currency", async () => {
    const { cookie } = await signUp(`rename-fixed-${crypto.randomUUID()}@example.com`);
    const id = await createAccount(cookie, { name: "Tili", broker: "op" });

    const response = await accountRoutes["/api/accounts/:id"].PATCH(
      new Request(`http://x/api/accounts/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ name: "Tili", broker: "nordnet", baseCurrency: "USD" }),
      }),
    );
    expect(response.status).toBe(200);
    // SAFETY: as above.
    const updated = (await response.json()) as { broker: string; baseCurrency: string };
    expect(updated.broker).toBe("op");
    expect(updated.baseCurrency).toBe("EUR");
  });
});

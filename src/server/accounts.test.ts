import { spawnSync } from "node:child_process";
import { getDb } from "./db/index.ts";
import {
  CreateAccount,
  listAccounts,
  openAccount as openAccountRow,
  updateAccount,
  UpdateAccount,
} from "./accounts.ts";
import { beforeAll, describe, expect, test } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { HttpError, handle, json } from "./http.ts";

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
  const httpPath = new URL("./http.ts", import.meta.url).pathname;
  const envWithoutSecret = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => key !== "BETTER_AUTH_SECRET" && key !== "DATABASE_PATH",
    ),
  );
  const scratchCwd = mkdtempSync(join(tmpdir(), "promptfolio-http-import-"));
  try {
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", `await import(${JSON.stringify(httpPath)}); console.log("ok")`],
      {
        encoding: "utf-8",
        cwd: scratchCwd,
        env: envWithoutSecret,
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("ok");
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
// call getDb()/migrate() itself: ../test-setup.ts (a vitest.config.ts
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

let auth: (typeof import("./auth.ts"))["auth"];
let assertAccountOwned: (typeof import("./accounts.ts"))["assertAccountOwned"];

beforeAll(async () => {
  const authModule = await import("./auth.ts");
  const accountsModule = await import("./accounts.ts");
  auth = authModule.auth;
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

describe("listAccounts", () => {
  // The no-session case is the authed middleware's, on every server function
  // that touches the ledger. It cannot be skipped by calling one.

  test("lists only the caller's own accounts", async () => {
    const owner = await signUp(`owner-${crypto.randomUUID()}@example.com`);
    const stranger = await signUp(`stranger-${crypto.randomUUID()}@example.com`);

    openAccountRow(
      getDb().db,
      owner.userId,
      CreateAccount.parse({ name: "Nordnet AOT", broker: "nordnet" }),
    );
    openAccountRow(
      getDb().db,
      stranger.userId,
      CreateAccount.parse({ name: "OP tili", broker: "op" }),
    );

    const body = listAccounts(getDb().db, owner.userId);
    expect(body).toEqual([expect.objectContaining({ name: "Nordnet AOT", userId: owner.userId })]);
  });
});

describe("openAccount", () => {
  // The no-session case is the authed middleware's, on every server function
  // that touches the ledger. It cannot be skipped by calling one.

  test("creates an account owned by the caller and defaults baseCurrency to EUR", async () => {
    const { userId } = await signUp(`creator-${crypto.randomUUID()}@example.com`);
    const body = openAccountRow(
      getDb().db,
      userId,
      CreateAccount.parse({ name: "Danske", broker: "danske" }),
    );
    expect(body.name).toBe("Danske");
    expect(body.userId).toBe(userId);
    expect(body.baseCurrency).toBe("EUR");
  });

  test("refuses an invalid body, naming every field that is wrong", () => {
    // The schema is the server function's validator, so this is the refusal a
    // caller actually meets -- and it names both problems, not just the first.
    const result = CreateAccount.safeParse({ name: "", broker: "not-a-real-broker" });

    expect(result.success).toBe(false);
    const fields = result.success ? [] : result.error.issues.map((issue) => issue.path[0]);
    expect(fields.sort()).toEqual(["broker", "name"]);
  });

  // §10a A1: the real portfolio holds SEK, never USD -- an account's base
  // currency must accept any real ISO 4217 code, not just EUR/USD.
  test("creates an account with an explicit non-EUR/USD ISO base currency (SEK)", async () => {
    const { userId } = await signUp(`sek-account-${crypto.randomUUID()}@example.com`);
    const body = openAccountRow(
      getDb().db,
      userId,
      CreateAccount.parse({ name: "Avanza", broker: "other", baseCurrency: "SEK" }),
    );
    expect(body.baseCurrency).toBe("SEK");
  });

  test("refuses a base currency that is not an ISO 4217 code", () => {
    const result = CreateAccount.safeParse({ name: "x", broker: "other", baseCurrency: "12" });

    expect(result.success).toBe(false);
    const fields = result.success ? [] : result.error.issues.map((issue) => issue.path[0]);
    expect(fields).toContain("baseCurrency");
  });
});

describe("assertAccountOwned", () => {
  test("does not throw for an account owned by the given user", async () => {
    const { userId } = await signUp(`assert-owned-${crypto.randomUUID()}@example.com`);
    const created = openAccountRow(
      getDb().db,
      userId,
      CreateAccount.parse({ name: "Spankki", broker: "spankki" }),
    );

    expect(() => assertAccountOwned(userId, created.id)).not.toThrow();
  });

  test("throws a 404 HttpError for an account owned by someone else", async () => {
    const owner = await signUp(`assert-other-owner-${crypto.randomUUID()}@example.com`);
    const stranger = await signUp(`assert-other-stranger-${crypto.randomUUID()}@example.com`);
    const created = openAccountRow(
      getDb().db,
      owner.userId,
      CreateAccount.parse({ name: "Nordnet ASA", broker: "nordnet" }),
    );
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
const createAccount = (userId: string, body: { name: string; broker: string }): number =>
  openAccountRow(getDb().db, userId, CreateAccount.parse(body)).id;

describe("updateAccount", () => {
  const rename = (userId: string, id: number, name: string) =>
    updateAccount(getDb().db, userId, id, UpdateAccount.parse({ name }));

  // The no-session case is the authed middleware's, on every server function
  // that touches the ledger. It cannot be skipped by calling one.

  test("renames an account the caller owns", async () => {
    const { userId } = await signUp(`rename-${crypto.randomUUID()}@example.com`);
    const id = createAccount(userId, { name: "Vanha nimi", broker: "nordnet" });

    expect(rename(userId, id, "Nordnet OST").name).toBe("Nordnet OST");
  });

  test("refuses an account belonging to someone else, as 404 rather than 403", async () => {
    const owner = await signUp(`rename-owner-${crypto.randomUUID()}@example.com`);
    const id = createAccount(owner.userId, { name: "Omistajan tili", broker: "op" });
    const stranger = await signUp(`rename-stranger-${crypto.randomUUID()}@example.com`);

    // Not found rather than forbidden: a stranger learns nothing, not even
    // that the account exists.
    expect(() => rename(stranger.userId, id, "Kaapattu")).toThrow();

    // And the name is untouched.
    const rows = listAccounts(getDb().db, owner.userId);
    expect(rows.find((row) => row.id === id)?.name).toBe("Omistajan tili");
  });

  test("refuses an empty name", async () => {
    const { userId } = await signUp(`rename-empty-${crypto.randomUUID()}@example.com`);
    createAccount(userId, { name: "Tili", broker: "op" });

    expect(UpdateAccount.safeParse({ name: "   " }).success).toBe(false);
  });

  // The broker and base currency are facts the stored transactions were already
  // interpreted under; changing either after rows exist would reinterpret them.
  test("cannot change the broker or the base currency", async () => {
    const { userId } = await signUp(`rename-fixed-${crypto.randomUUID()}@example.com`);
    const id = createAccount(userId, { name: "Tili", broker: "op" });

    // The schema drops them: broker and base currency are facts the stored
    // transactions were already interpreted under, so changing either after
    // rows exist would reinterpret them.
    const updated = updateAccount(
      getDb().db,
      userId,
      id,
      UpdateAccount.parse({ name: "Tili", broker: "nordnet", baseCurrency: "USD" }),
    );

    expect(updated.broker).toBe("op");
    expect(updated.baseCurrency).toBe("EUR");
  });
});

/** The row shape /api/accounts returns, parsed rather than cast. */

test("stores an account type at creation, and leaves it null when unstated", async () => {
  const { userId } = await signUp(`type-create-${crypto.randomUUID()}@example.com`);

  const withType = openAccountRow(
    getDb().db,
    userId,
    CreateAccount.parse({
      name: "Nordnet OST",
      broker: "nordnet",
      accountType: "ost",
    }),
  );
  expect(withType.accountType).toBe("ost");

  const without = openAccountRow(
    getDb().db,
    userId,
    CreateAccount.parse({ name: "Tuntematon", broker: "op" }),
  );
  // Null, not "aot": an unconfirmed type must not read as an ordinary account.
  expect(without.accountType).toBeNull();
});

test("changes the account type without touching the name, and can clear it", async () => {
  const { userId } = await signUp(`type-patch-${crypto.randomUUID()}@example.com`);
  const created = openAccountRow(
    getDb().db,
    userId,
    CreateAccount.parse({ name: "Nordnet", broker: "nordnet" }),
  );
  const id = created.id;
  const patch = (body: { name?: string; accountType?: "aot" | "ost" | "other" | null }) =>
    updateAccount(getDb().db, userId, id, UpdateAccount.parse(body));

  const typed = patch({ accountType: "ost" });
  expect(typed.accountType).toBe("ost");
  expect(typed.name).toBe("Nordnet");

  const renamed = patch({ name: "Nordnet OST" });
  expect(renamed.accountType).toBe("ost");
  expect(renamed.name).toBe("Nordnet OST");

  const cleared = patch({ accountType: null });
  expect(cleared.accountType).toBeNull();

  // An empty change is refused rather than treated as a no-op: it means the
  // caller sent a form with nothing filled in.
  expect(UpdateAccount.safeParse({}).success).toBe(false);
});

test("refuses a bank account type on a brokerage account, and the reverse", async () => {
  const { userId } = await signUp(`kind-mismatch-${crypto.randomUUID()}@example.com`);

  // "A brokerage account that is a savings account" is not a typo with an
  // obvious fix, so it is refused rather than corrected.
  expect(() =>
    openAccountRow(
      getDb().db,
      userId,
      CreateAccount.parse({
        name: "Sekava",
        broker: "op",
        accountType: "savings",
      }),
    ),
  ).toThrow();

  expect(() =>
    openAccountRow(
      getDb().db,
      userId,
      CreateAccount.parse({
        name: "Sekava",
        broker: "op",
        kind: "bank",
        accountType: "ost",
      }),
    ),
  ).toThrow();
});

test("defaults an account to brokerage, which is what every earlier one was", async () => {
  const { userId } = await signUp(`kind-default-${crypto.randomUUID()}@example.com`);

  const created = openAccountRow(
    getDb().db,
    userId,
    CreateAccount.parse({ name: "Nordnet", broker: "nordnet" }),
  );

  expect(created.kind).toBe("brokerage");
});

test("refuses to move an account's type to the other kind's set after creation", async () => {
  const { userId } = await signUp(`kind-patch-${crypto.randomUUID()}@example.com`);
  const id = openAccountRow(
    getDb().db,
    userId,
    CreateAccount.parse({ name: "OP käyttötili", broker: "op", kind: "bank" }),
  ).id;

  // A bank account cannot become an arvo-osuustili by editing its type: the
  // kind decides which types are allowed, and the kind does not change.
  expect(() =>
    updateAccount(getDb().db, userId, id, UpdateAccount.parse({ accountType: "aot" })),
  ).toThrow();
});

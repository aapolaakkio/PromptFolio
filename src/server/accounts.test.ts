import { spawnSync } from "node:child_process";
import { db } from "./db/index.ts";
import { listAccounts, openAccount as openAccountRow, updateAccount } from "./accounts.ts";
import { CreateAccount, UpdateAccount } from "./action-inputs.ts";
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
    throw new HttpError(403, "Forbidden");
  })(new Request("http://x/"));
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: "Forbidden" });
});

test("maps a Zod failure to 400 with field detail", async () => {
  const schema = z.object({ name: z.string().min(1) });
  const response = await handle(async () => {
    schema.parse({ name: "" });
    return json({});
  })(new Request("http://x/"));
  expect(response.status).toBe(400);
  // SAFETY: handle()'s ZodError branch (status 400) shapes its body as `{ error, fields: [{ path, message }] }`.
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
// Proved in a child process (not a dynamic import, which module caching could hide): plain Node cannot resolve
// `cloudflare:workers`, so exit 0 means http.ts reaches neither the db nor auth.ts (HttpError is re-exported from errors.ts).
test("importing http.ts alone needs no BETTER_AUTH_SECRET and opens no database", () => {
  const httpPath = new URL("./http.ts", import.meta.url).pathname;
  // Blanked rather than deleted: `wrangler types` declares these as required strings, and resolveAuthSecret refuses an empty one anyway.
  const envWithoutSecret: NodeJS.ProcessEnv = { ...process.env, BETTER_AUTH_SECRET: "" };
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

// --- account functions / assertAccountOwned ---
// Need a real migrated database and Better Auth session. test-setup.ts has already pinned the shared in-memory database,
// so never reset it here; auth.ts is a process-wide singleton, so import it dynamically from beforeAll.

let auth: ReturnType<(typeof import("./auth.ts"))["getAuth"]>;
let assertAccountOwned: (typeof import("./accounts.ts"))["assertAccountOwned"];

beforeAll(async () => {
  const authModule = await import("./auth.ts");
  const accountsModule = await import("./accounts.ts");
  auth = authModule.getAuth();
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
  // SAFETY: Better Auth's sign-up response always carries `{ token, user: { id } }`.
  const body = (await response.json()) as { user: { id: string } };
  return { userId: body.user.id, cookie: sessionCookieFrom(response) };
};

describe("listAccounts", () => {
  test("lists only the caller's own accounts", async () => {
    const owner = await signUp(`owner-${crypto.randomUUID()}@example.com`);
    const stranger = await signUp(`stranger-${crypto.randomUUID()}@example.com`);

    await openAccountRow(
      db,
      owner.userId,
      CreateAccount.parse({ name: "Nordnet AOT", broker: "nordnet" }),
    );
    await openAccountRow(
      db,
      stranger.userId,
      CreateAccount.parse({ name: "OP account", broker: "op" }),
    );

    const body = await listAccounts(db, owner.userId);
    expect(body).toEqual([expect.objectContaining({ name: "Nordnet AOT", userId: owner.userId })]);
  });
});

describe("openAccount", () => {
  test("creates an account owned by the caller and defaults baseCurrency to EUR", async () => {
    const { userId } = await signUp(`creator-${crypto.randomUUID()}@example.com`);
    const body = await openAccountRow(
      db,
      userId,
      CreateAccount.parse({ name: "Danske", broker: "danske" }),
    );
    expect(body.name).toBe("Danske");
    expect(body.userId).toBe(userId);
    expect(body.baseCurrency).toBe("EUR");
  });

  test("refuses an invalid body, naming every field that is wrong", () => {
    // The schema is the validator, so this is the refusal a caller meets; it names both problems.
    const result = CreateAccount.safeParse({ name: "", broker: "not-a-real-broker" });

    expect(result.success).toBe(false);
    const fields = result.success ? [] : result.error.issues.map((issue) => String(issue.path[0]));
    expect(fields.sort()).toEqual(["broker", "name"]);
  });

  // The real portfolio holds SEK: base currency must accept any ISO 4217 code.
  test("creates an account with an explicit non-EUR/USD ISO base currency (SEK)", async () => {
    const { userId } = await signUp(`sek-account-${crypto.randomUUID()}@example.com`);
    const body = await openAccountRow(
      db,
      userId,
      CreateAccount.parse({ name: "Avanza", broker: "other", baseCurrency: "SEK" }),
    );
    expect(body.baseCurrency).toBe("SEK");
  });

  test("refuses a base currency that is not an ISO 4217 code", () => {
    const result = CreateAccount.safeParse({ name: "x", broker: "other", baseCurrency: "12" });

    expect(result.success).toBe(false);
    const fields = result.success ? [] : result.error.issues.map((issue) => String(issue.path[0]));
    expect(fields).toContain("baseCurrency");
  });
});

describe("assertAccountOwned", () => {
  test("does not throw for an account owned by the given user", async () => {
    const { userId } = await signUp(`assert-owned-${crypto.randomUUID()}@example.com`);
    const created = await openAccountRow(
      db,
      userId,
      CreateAccount.parse({ name: "Spankki", broker: "spankki" }),
    );

    await expect(assertAccountOwned(userId, created.id)).resolves.toBeUndefined();
  });

  test("throws a 404 HttpError for an account owned by someone else", async () => {
    const owner = await signUp(`assert-other-owner-${crypto.randomUUID()}@example.com`);
    const stranger = await signUp(`assert-other-stranger-${crypto.randomUUID()}@example.com`);
    const created = await openAccountRow(
      db,
      owner.userId,
      CreateAccount.parse({ name: "Nordnet ASA", broker: "nordnet" }),
    );
    await expect(assertAccountOwned(stranger.userId, created.id)).rejects.toThrow(
      expect.objectContaining({ status: 404 }),
    );
  });

  test("throws a 404 HttpError for an account id that does not exist", async () => {
    await expect(assertAccountOwned("nobody", 999_999)).rejects.toThrow(
      expect.objectContaining({ status: 404 }),
    );
  });
});

/** Creates an account and returns its id; this file otherwise posts inline. */
const createAccount = async (
  userId: string,
  body: { name: string; broker: string },
): Promise<number> => (await openAccountRow(db, userId, CreateAccount.parse(body))).id;

describe("updateAccount", () => {
  const rename = (userId: string, id: number, name: string) =>
    updateAccount(db, userId, id, UpdateAccount.parse({ name }));

  test("renames an account the caller owns", async () => {
    const { userId } = await signUp(`rename-${crypto.randomUUID()}@example.com`);
    const id = await createAccount(userId, { name: "Old name", broker: "nordnet" });

    expect((await rename(userId, id, "Nordnet OST"))?.name).toBe("Nordnet OST");
  });

  test("refuses an account belonging to someone else, as 404 rather than 403", async () => {
    const owner = await signUp(`rename-owner-${crypto.randomUUID()}@example.com`);
    const id = await createAccount(owner.userId, { name: "Owner's account", broker: "op" });
    const stranger = await signUp(`rename-stranger-${crypto.randomUUID()}@example.com`);

    // Not found rather than forbidden: a stranger learns nothing, not even that the account exists.
    await expect(rename(stranger.userId, id, "Kaapattu")).rejects.toThrow();

    const rows = await listAccounts(db, owner.userId);
    expect(rows.find((row) => row.id === id)?.name).toBe("Owner's account");
  });

  test("refuses an empty name", async () => {
    const { userId } = await signUp(`rename-empty-${crypto.randomUUID()}@example.com`);
    await createAccount(userId, { name: "Account", broker: "op" });

    expect(UpdateAccount.safeParse({ name: "   " }).success).toBe(false);
  });

  // Broker and base currency are facts stored transactions were interpreted under; changing either would reinterpret them.
  test("cannot change the broker or the base currency", async () => {
    const { userId } = await signUp(`rename-fixed-${crypto.randomUUID()}@example.com`);
    const id = await createAccount(userId, { name: "Account", broker: "op" });

    const updated = await updateAccount(
      db,
      userId,
      id,
      UpdateAccount.parse({ name: "Account", broker: "nordnet", baseCurrency: "USD" }),
    );

    expect(updated?.broker).toBe("op");
    expect(updated?.baseCurrency).toBe("EUR");
  });
});

/** The row shape /api/accounts returns, parsed rather than cast. */

test("stores an account type at creation, and leaves it null when unstated", async () => {
  const { userId } = await signUp(`type-create-${crypto.randomUUID()}@example.com`);

  const withType = await openAccountRow(
    db,
    userId,
    CreateAccount.parse({
      name: "Nordnet OST",
      broker: "nordnet",
      accountType: "ost",
    }),
  );
  expect(withType.accountType).toBe("ost");

  const without = await openAccountRow(
    db,
    userId,
    CreateAccount.parse({ name: "Unknown", broker: "op" }),
  );
  // Null, not "aot": an unconfirmed type must not read as an ordinary account.
  expect(without.accountType).toBeNull();
});

test("changes the account type without touching the name, and can clear it", async () => {
  const { userId } = await signUp(`type-patch-${crypto.randomUUID()}@example.com`);
  const created = await openAccountRow(
    db,
    userId,
    CreateAccount.parse({ name: "Nordnet", broker: "nordnet" }),
  );
  const id = created.id;
  const patch = (body: { name?: string; accountType?: "aot" | "ost" | "other" | null }) =>
    updateAccount(db, userId, id, UpdateAccount.parse(body));

  const typed = await patch({ accountType: "ost" });
  expect(typed?.accountType).toBe("ost");
  expect(typed?.name).toBe("Nordnet");

  const renamed = await patch({ name: "Nordnet OST" });
  expect(renamed?.accountType).toBe("ost");
  expect(renamed?.name).toBe("Nordnet OST");

  const cleared = await patch({ accountType: null });
  expect(cleared?.accountType).toBeNull();

  // An empty change is refused: it means a form with nothing filled in.
  expect(UpdateAccount.safeParse({}).success).toBe(false);
});

test("refuses a bank account type on a brokerage account, and the reverse", async () => {
  const { userId } = await signUp(`kind-mismatch-${crypto.randomUUID()}@example.com`);

  // "A brokerage account that is a savings account" has no obvious fix, so it is refused rather than corrected.
  await expect(
    openAccountRow(
      db,
      userId,
      CreateAccount.parse({
        name: "Confusing",
        broker: "op",
        accountType: "savings",
      }),
    ),
  ).rejects.toThrow();

  await expect(
    openAccountRow(
      db,
      userId,
      CreateAccount.parse({
        name: "Confusing",
        broker: "op",
        kind: "bank",
        accountType: "ost",
      }),
    ),
  ).rejects.toThrow();
});

test("defaults an account to brokerage, which is what every earlier one was", async () => {
  const { userId } = await signUp(`kind-default-${crypto.randomUUID()}@example.com`);

  const created = await openAccountRow(
    db,
    userId,
    CreateAccount.parse({ name: "Nordnet", broker: "nordnet" }),
  );

  expect(created.kind).toBe("brokerage");
});

test("refuses to move an account's type to the other kind's set after creation", async () => {
  const { userId } = await signUp(`kind-patch-${crypto.randomUUID()}@example.com`);
  const id = (
    await openAccountRow(
      db,
      userId,
      CreateAccount.parse({ name: "OP current account", broker: "op", kind: "bank" }),
    )
  ).id;

  // A bank account cannot become a securities account by editing its type: the kind decides the allowed types.
  await expect(
    updateAccount(db, userId, id, UpdateAccount.parse({ accountType: "aot" })),
  ).rejects.toThrow();
});

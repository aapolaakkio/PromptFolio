import { beforeAll, describe, expect, test } from "bun:test";
import { NORDNET } from "../import/brokers";

// This file exercises importRoutes (preview/commit/undo) and
// detectBrokerConfig against a real, migrated database and a real Better
// Auth session, mirroring src/server/api/accounts.test.ts's setup —
// including its reliance on ../test-setup.ts (a bunfig.toml [test]
// preload script) to have already pinned the shared getDb() handle to a
// migrated in-memory database before this file's own code runs. This file
// must NOT call resetDbHandleForTests(), set DATABASE_PATH, or call
// getDb()/migrate() itself — see test-setup.ts's comment for why.
//
// Per-test data is scoped by a fresh crypto.randomUUID()-derived email (and
// therefore a fresh account/instrument set per test) rather than relying
// on any particular starting state, since every test in the process shares
// one in-memory database.

let auth: (typeof import("../auth"))["auth"];
let accountRoutes: (typeof import("./accounts"))["accountRoutes"];
let instrumentRoutes: (typeof import("./instruments"))["instrumentRoutes"];
let importRoutes: (typeof import("./imports"))["importRoutes"];
let detectBrokerConfig: (typeof import("./imports"))["detectBrokerConfig"];

beforeAll(async () => {
  const authModule = await import("../auth");
  const accountsModule = await import("./accounts");
  const instrumentsModule = await import("./instruments");
  const importsModule = await import("./imports");
  auth = authModule.auth;
  accountRoutes = accountsModule.accountRoutes;
  instrumentRoutes = instrumentsModule.instrumentRoutes;
  importRoutes = importsModule.importRoutes;
  detectBrokerConfig = importsModule.detectBrokerConfig;
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

const openAccount = async (
  cookie: string,
  broker: "nordnet" | "op" = "nordnet",
): Promise<number> => {
  const response = await accountRoutes["/api/accounts"].POST(
    new Request("http://x/api/accounts", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "Test tili", broker }),
    }),
  );
  // SAFETY: a 201 from POST /api/accounts always returns the inserted row,
  // which carries an `id` column.
  const created = (await response.json()) as { id: number };
  return created.id;
};

const registerNokia = async (cookie: string): Promise<void> => {
  await instrumentRoutes["/api/instruments"].POST(
    new Request("http://x/api/instruments", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        isin: "FI0009000681",
        ticker: "NOKIA.HE",
        name: "Nokia",
        kind: "stock",
        currency: "EUR",
        priceSource: "yahoo",
        sourceKey: "NOKIA.HE",
      }),
    }),
  );
};

const NORDNET_HEADER =
  "Id;Kauppapäivä;Tapahtumatyyppi;Arvopaperi;ISIN;Määrä;Kurssi;Kokonaiskulut;Valuutta;Summa";

const csvFile = (contents: string, name = "export.csv"): File =>
  new File([contents], name, { type: "text/csv" });

const uploadRequest = (
  url: string,
  cookie: string | undefined,
  file: File | undefined,
  accountId: number | string | undefined,
): Request => {
  const form = new FormData();
  if (file) form.append("file", file);
  if (accountId !== undefined) form.append("accountId", String(accountId));
  return new Request(url, {
    method: "POST",
    headers: cookie ? { cookie } : {},
    body: form,
  });
};

const fixture = (name: string) => Bun.file(`${import.meta.dir}/../import/fixtures/${name}`).text();

// --- detectBrokerConfig (delimiter/encoding independence) ---
//
// Both shipped brokers (Nordnet, OP) happen to use ';' and utf-8 today, so
// a hardcoded ';'+utf-8 probe (what the task brief originally coded, see
// task-12-report.md) would pass every test built only from real fixtures.
// These tests force a different combination via the `configs` parameter to
// prove detectBrokerConfig tries each candidate's own delimiter/encoding,
// not one fixed pair.

describe("detectBrokerConfig", () => {
  test("still detects a real Nordnet export with the default broker list", async () => {
    const bytes = new TextEncoder().encode(await fixture("nordnet-sample.csv")).buffer;
    expect(detectBrokerConfig(bytes)?.broker).toBe("nordnet");
  });

  test("still detects a real OP export with the default broker list", async () => {
    const bytes = new TextEncoder().encode(await fixture("op-sample.csv")).buffer;
    expect(detectBrokerConfig(bytes)?.broker).toBe("op");
  });

  test("detects a broker whose export uses a different delimiter than ';'", () => {
    // Same header text as Nordnet's real signature columns, but joined
    // with tabs instead of ';'. A hardcoded ';' split would leave this as
    // one unsplit field and never find "Tapahtumatyyppi"/"ISIN"/"Summa" as
    // separate headers.
    const header = NORDNET_HEADER.replaceAll(";", "\t");
    const bytes = new TextEncoder().encode(`${header}\n`).buffer;
    const tabDelimited = { ...NORDNET, delimiter: "\t" };
    expect(detectBrokerConfig(bytes, [tabDelimited])?.broker).toBe("nordnet");
    // The same bytes, probed only with the real (';'-delimited) config,
    // must NOT be detected -- confirms the delimiter substitution above is
    // actually doing something, not a no-op.
    expect(detectBrokerConfig(bytes, [NORDNET])).toBeNull();
  });

  test("returns null when no configured broker's signature matches", () => {
    const bytes = new TextEncoder().encode("Date;Amount\n2025-01-01;5\n").buffer;
    expect(detectBrokerConfig(bytes)).toBeNull();
  });
});

// --- POST /api/imports/preview ---

describe("POST /api/imports/preview", () => {
  test("rejects a request with no session", async () => {
    const response = await importRoutes["/api/imports/preview"].POST(
      uploadRequest("http://x/api/imports/preview", undefined, csvFile("a;b\n1;2\n"), 1),
    );
    expect(response.status).toBe(401);
  });

  test("rejects an account the caller does not own", async () => {
    const owner = await signUp(`imp-preview-owner-${crypto.randomUUID()}@example.com`);
    const stranger = await signUp(`imp-preview-stranger-${crypto.randomUUID()}@example.com`);
    const accountId = await openAccount(owner.cookie);

    const response = await importRoutes["/api/imports/preview"].POST(
      uploadRequest(
        "http://x/api/imports/preview",
        stranger.cookie,
        csvFile(`${NORDNET_HEADER}\n`),
        accountId,
      ),
    );
    expect(response.status).toBe(404);
  });

  test("rejects a request with no file", async () => {
    const { cookie } = await signUp(`imp-preview-nofile-${crypto.randomUUID()}@example.com`);
    const accountId = await openAccount(cookie);
    const response = await importRoutes["/api/imports/preview"].POST(
      uploadRequest("http://x/api/imports/preview", cookie, undefined, accountId),
    );
    expect(response.status).toBe(400);
  });

  test("rejects a request with a missing account id", async () => {
    const { cookie } = await signUp(`imp-preview-noaccount-${crypto.randomUUID()}@example.com`);
    const response = await importRoutes["/api/imports/preview"].POST(
      uploadRequest(
        "http://x/api/imports/preview",
        cookie,
        csvFile(`${NORDNET_HEADER}\n`),
        undefined,
      ),
    );
    expect(response.status).toBe(400);
  });

  test("rejects an oversized file with 413", async () => {
    const { cookie } = await signUp(`imp-preview-huge-${crypto.randomUUID()}@example.com`);
    const accountId = await openAccount(cookie);
    const huge = csvFile(`${NORDNET_HEADER}\n${"x".repeat(6 * 1024 * 1024)}`);
    const response = await importRoutes["/api/imports/preview"].POST(
      uploadRequest("http://x/api/imports/preview", cookie, huge, accountId),
    );
    expect(response.status).toBe(413);
  });

  test("rejects a CSV whose broker cannot be identified", async () => {
    const { cookie } = await signUp(`imp-preview-unknown-${crypto.randomUUID()}@example.com`);
    const accountId = await openAccount(cookie);
    const response = await importRoutes["/api/imports/preview"].POST(
      uploadRequest(
        "http://x/api/imports/preview",
        cookie,
        csvFile("Date;Amount\n2025-01-01;5\n"),
        accountId,
      ),
    );
    expect(response.status).toBe(400);
    // SAFETY: handle()'s HttpError branch (asserted above via status 400)
    // always shapes its body as `{ error }`.
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("välittäjää");
  });

  test("previews a real Nordnet export and reports the unresolved isin", async () => {
    const { cookie } = await signUp(`imp-preview-ok-${crypto.randomUUID()}@example.com`);
    const accountId = await openAccount(cookie);
    const nordnetCsv = await fixture("nordnet-sample.csv");
    const response = await importRoutes["/api/imports/preview"].POST(
      uploadRequest("http://x/api/imports/preview", cookie, csvFile(nordnetCsv), accountId),
    );
    expect(response.status).toBe(200);
    // SAFETY: a 200 from POST /api/imports/preview (asserted above) always
    // returns { broker, filename, sha256, txns, problems, unknownIsins }.
    const body = (await response.json()) as {
      broker: string;
      txns: unknown[];
      unknownIsins: Array<{ isin: string }>;
    };
    expect(body.broker).toBe("nordnet");
    expect(body.txns).toHaveLength(5);
    expect(body.unknownIsins.some((u) => u.isin === "IE00B4L5Y983")).toBe(true);
  });
});

// --- POST /api/imports/commit ---

describe("POST /api/imports/commit", () => {
  test("rejects a request with no session", async () => {
    const response = await importRoutes["/api/imports/commit"].POST(
      uploadRequest("http://x/api/imports/commit", undefined, csvFile(`${NORDNET_HEADER}\n`), 1),
    );
    expect(response.status).toBe(401);
  });

  test("rejects an account the caller does not own", async () => {
    const owner = await signUp(`imp-commit-owner-${crypto.randomUUID()}@example.com`);
    const stranger = await signUp(`imp-commit-stranger-${crypto.randomUUID()}@example.com`);
    const accountId = await openAccount(owner.cookie);
    const response = await importRoutes["/api/imports/commit"].POST(
      uploadRequest(
        "http://x/api/imports/commit",
        stranger.cookie,
        csvFile(`${NORDNET_HEADER}\n`),
        accountId,
      ),
    );
    expect(response.status).toBe(404);
  });

  test("refuses to commit a draft with an unresolved isin", async () => {
    const { cookie } = await signUp(`imp-commit-unknown-isin-${crypto.randomUUID()}@example.com`);
    const accountId = await openAccount(cookie);
    const nordnetCsv = await fixture("nordnet-sample.csv");
    const response = await importRoutes["/api/imports/commit"].POST(
      uploadRequest("http://x/api/imports/commit", cookie, csvFile(nordnetCsv), accountId),
    );
    expect(response.status).toBe(400);
    // SAFETY: handle()'s HttpError branch (asserted above via status 400)
    // always shapes its body as `{ error }`.
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("IE00B4L5Y983");
  });

  test("commits a clean EUR-only export and undoes it", async () => {
    const { cookie } = await signUp(`imp-commit-ok-${crypto.randomUUID()}@example.com`);
    const accountId = await openAccount(cookie);
    await registerNokia(cookie);
    const csv = `${NORDNET_HEADER}\n2001;2025-01-10;OSTO;NOKIA;FI0009000681;100;4,15;3,00;EUR;-418,00\n`;

    const commitResponse = await importRoutes["/api/imports/commit"].POST(
      uploadRequest("http://x/api/imports/commit", cookie, csvFile(csv), accountId),
    );
    expect(commitResponse.status).toBe(201);
    // SAFETY: a 201 from POST /api/imports/commit (asserted above) always
    // returns { importId, inserted, skipped }.
    const commitBody = (await commitResponse.json()) as {
      importId: number;
      inserted: number;
      skipped: number;
    };
    expect(commitBody.inserted).toBe(1);
    expect(commitBody.skipped).toBe(0);

    const undoResponse = await importRoutes["/api/imports/:id/undo"].POST(
      new Request(`http://x/api/imports/${commitBody.importId}/undo`, {
        method: "POST",
        headers: { cookie },
      }),
    );
    expect(undoResponse.status).toBe(200);
    expect(await undoResponse.json()).toEqual({ deleted: 1 });
  });
});

// --- POST /api/imports/:id/undo ---

describe("POST /api/imports/:id/undo", () => {
  test("rejects a request with no session", async () => {
    const response = await importRoutes["/api/imports/:id/undo"].POST(
      new Request("http://x/api/imports/1/undo", { method: "POST" }),
    );
    expect(response.status).toBe(401);
  });

  test("rejects undoing an import belonging to another user", async () => {
    const owner = await signUp(`imp-undo-owner-${crypto.randomUUID()}@example.com`);
    const stranger = await signUp(`imp-undo-stranger-${crypto.randomUUID()}@example.com`);
    const accountId = await openAccount(owner.cookie);
    await registerNokia(owner.cookie);
    const csv = `${NORDNET_HEADER}\n3001;2025-01-10;TALLETUS;;;0;0;0;EUR;500,00\n`;
    const commitResponse = await importRoutes["/api/imports/commit"].POST(
      uploadRequest("http://x/api/imports/commit", owner.cookie, csvFile(csv), accountId),
    );
    // SAFETY: commit succeeded (the csv above is a plain EUR deposit,
    // nothing to resolve), so the body carries an importId.
    const { importId } = (await commitResponse.json()) as { importId: number };

    const undoResponse = await importRoutes["/api/imports/:id/undo"].POST(
      new Request(`http://x/api/imports/${importId}/undo`, {
        method: "POST",
        headers: { cookie: stranger.cookie },
      }),
    );
    expect(undoResponse.status).toBe(404);
  });

  test("rejects a non-numeric import id with 400", async () => {
    const { cookie } = await signUp(`imp-undo-badid-${crypto.randomUUID()}@example.com`);
    const response = await importRoutes["/api/imports/:id/undo"].POST(
      new Request("http://x/api/imports/not-a-number/undo", {
        method: "POST",
        headers: { cookie },
      }),
    );
    expect(response.status).toBe(400);
  });
});

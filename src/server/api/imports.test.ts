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

const NORDNET_HEADER = [
  "Id",
  "Kirjauspäivä",
  "Kauppapäivä",
  "Maksupäivä",
  "Salkku",
  "Tapahtumatyyppi",
  "Arvopaperi",
  "ISIN",
  "Määrä",
  "Kurssi",
  "Korko",
  "Kokonaiskulut",
  "Valuutta",
  "Summa",
  "Valuutta",
  "Hankinta-arvo",
  "Valuutta",
  "Tulos",
  "Valuutta",
  "Kokonaismäärä",
  "Saldo",
  "Vaihtokurssi",
  "Tapahtumateksti",
  "Mitätöintipäivä",
  "Laskelma",
  "Vahvistusnumero",
  "Välityspalkkio",
  "Valuutta",
  "Viitevaluuttakurssi",
  "Alkuperäinen korko",
].join("\t");

/** Builds one 30-column real-format Nordnet row, blank everywhere not given. */
const nordnetRow = (o: {
  id: string;
  date: string;
  type: string;
  name?: string;
  isin?: string;
  qty?: string;
  price?: string;
  fee?: string;
  currency?: string;
  amount: string;
}): string => {
  const c = Array.from({ length: 30 }, () => "");
  c[0] = o.id;
  c[1] = o.date;
  c[2] = o.date;
  c[3] = o.date;
  c[4] = "11223344";
  c[5] = o.type;
  c[6] = o.name ?? "";
  c[7] = o.isin ?? "";
  c[8] = o.qty ?? "";
  c[9] = o.price ?? "";
  c[10] = "0";
  c[11] = o.fee ?? "";
  c[12] = o.currency ?? "";
  c[13] = o.amount;
  c[14] = "EUR";
  return c.join("\t");
};

/** UTF-16LE-with-BOM bytes, matching NORDNET's real encoding, for a tab-joined body of text. */
const nordnetBytes = (text: string): ArrayBuffer => {
  const withBom = `﻿${text}`;
  const bytes = new Uint8Array(withBom.length * 2);
  for (let i = 0; i < withBom.length; i++) {
    const code = withBom.charCodeAt(i);
    bytes[i * 2] = code & 0xff;
    bytes[i * 2 + 1] = (code >> 8) & 0xff;
  }
  return bytes.buffer;
};

const csvFile = (contents: string, name = "export.csv"): File =>
  new File([contents], name, { type: "text/csv" });

/** A File built directly from bytes, for an already-encoded (e.g. UTF-16LE) body. */
const binaryFile = (bytes: ArrayBuffer, name = "export.csv"): File =>
  new File([bytes], name, { type: "text/csv" });

/** A Nordnet-shaped upload: real header + one real-format row, UTF-16LE-with-BOM encoded. */
const nordnetFile = (row: string, name = "export.csv"): File =>
  binaryFile(nordnetBytes(`${NORDNET_HEADER}\n${row}\n`), name);

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

const fixtureBytes = (name: string) =>
  Bun.file(`${import.meta.dir}/../import/fixtures/${name}`).arrayBuffer();

// --- detectBrokerConfig (delimiter/encoding independence) ---

describe("detectBrokerConfig", () => {
  test("still detects a real Nordnet export with the default broker list", async () => {
    const bytes = await fixtureBytes("nordnet-sample.csv"); // already UTF-16LE on disk
    expect(detectBrokerConfig(bytes)?.broker).toBe("nordnet");
  });

  // OP's web-paste view is newline-separated with no delimiter at all (see
  // src/server/import/op-paste.ts) -- it is not a `BrokerCsvConfig` and is
  // deliberately absent from `BROKER_CONFIGS`, so `detectBrokerConfig`
  // (which only ever tries `parseCsv`-shaped candidates) correctly does
  // not, and cannot, detect it. This stays true even after Task 20 wired
  // OP paste into its own routes (see the "op-paste" describe blocks
  // below): those routes call `buildPasteDraft`/`parseOpPaste` directly and
  // never go through `detectBrokerConfig`/`buildDraft`'s file-upload path
  // at all -- see brokers.ts's `BROKER_CONFIGS` comment.
  test("does not detect an OP paste -- it is not wired into the CSV-upload broker list", async () => {
    const text = await Bun.file(
      `${import.meta.dir}/../import/fixtures/op-web-paste-sample.txt`,
    ).text();
    const bytes = new TextEncoder().encode(text).buffer;
    expect(detectBrokerConfig(bytes)).toBeNull();
  });

  test("detects a broker whose export uses a different delimiter than the real config", () => {
    // `BROKER_CONFIGS` only has one real entry (Nordnet, tab-delimited)
    // now, so this forces a different (comma) delimiter via the `configs`
    // parameter to prove detectBrokerConfig tries each candidate's own
    // delimiter/encoding rather than one hardcoded pair (what the task
    // brief originally coded, see task-12-report.md).
    const header = NORDNET_HEADER.replaceAll("\t", ",");
    const bytes = new TextEncoder().encode(`${header}\n`).buffer;
    const commaDelimited = { ...NORDNET, delimiter: ",", encoding: "utf-8" as const };
    expect(detectBrokerConfig(bytes, [commaDelimited])?.broker).toBe("nordnet");
    // The same bytes, probed only with the real (tab-delimited, UTF-16LE)
    // config, must NOT be detected -- confirms the substitution above is
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

  test("previews a real Nordnet export and reports the unresolved isins", async () => {
    const { cookie } = await signUp(`imp-preview-ok-${crypto.randomUUID()}@example.com`);
    const accountId = await openAccount(cookie);
    const nordnetBytesFile = await fixtureBytes("nordnet-sample.csv");
    const response = await importRoutes["/api/imports/preview"].POST(
      uploadRequest(
        "http://x/api/imports/preview",
        cookie,
        binaryFile(nordnetBytesFile),
        accountId,
      ),
    );
    expect(response.status).toBe(200);
    // SAFETY: a 200 from POST /api/imports/preview (asserted above) always
    // returns { broker, filename, sha256, txns, problems, unknownIsins }.
    const body = (await response.json()) as {
      broker: string;
      txns: unknown[];
      unknownIsins: Array<{ isin: string | null }>;
    };
    expect(body.broker).toBe("nordnet");
    // 13 data rows in the fixture, 4 of them (the VAIHTO merger pair and
    // the two DESIM rows) deliberately unmapped -- see brokers.ts -- so 9
    // reach the draft as transactions.
    expect(body.txns).toHaveLength(9);
    // No instrument is pre-registered for this fresh user, so every isin
    // among the mapped rows is unresolved; SE0005993102 (the MYYNTI row)
    // is one of them. VAIHTO's isins never reach unknown-instrument
    // tracking at all -- an unmapped type throws before isin extraction.
    expect(body.unknownIsins.some((u) => u.isin === "SE0005993102")).toBe(true);
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
    const nordnetBytesFile = await fixtureBytes("nordnet-sample.csv");
    const response = await importRoutes["/api/imports/commit"].POST(
      uploadRequest("http://x/api/imports/commit", cookie, binaryFile(nordnetBytesFile), accountId),
    );
    expect(response.status).toBe(400);
    // SAFETY: handle()'s HttpError branch (asserted above via status 400)
    // always shapes its body as `{ error }`.
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("SE0005993102");
  });

  test("commits a clean EUR-only export and undoes it", async () => {
    const { cookie } = await signUp(`imp-commit-ok-${crypto.randomUUID()}@example.com`);
    const accountId = await openAccount(cookie);
    await registerNokia(cookie);
    const row = nordnetRow({
      id: "2001",
      date: "2025-01-10",
      type: "OSTO",
      name: "NOKIA",
      isin: "FI0009000681",
      qty: "100",
      price: "4,15",
      fee: "3,00",
      currency: "EUR",
      amount: "-418,00",
    });

    const commitResponse = await importRoutes["/api/imports/commit"].POST(
      uploadRequest("http://x/api/imports/commit", cookie, nordnetFile(row), accountId),
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

  test("a commit still returns 201 even when the backfill it fires afterwards can't reach any price source", async () => {
    // No fetchImpl is injected anywhere in this test -- the route has no way to accept one
    // (matching how ensureDraftFxRates's ECB fetch is never stubbed through the route either;
    // see this describe block's other EUR-only tests), so the fire-and-forget backfill this
    // commit triggers (src/server/api/imports.ts's `fireBackfill`) hits the real global fetch,
    // which src/server/test-network-guard.ts replaces with one that always throws. This proves
    // the constraint end to end: a commit whose own rows are all perfectly valid must not be
    // reported as failed just because the price source its backfill needs is unreachable.
    const { cookie } = await signUp(
      `imp-commit-backfill-isolated-${crypto.randomUUID()}@example.com`,
    );
    const accountId = await openAccount(cookie);
    await registerNokia(cookie);

    const { getDb } = await import("../db");
    const { instruments, priceFetchLog } = await import("../db/schema");
    const { asc, eq } = await import("drizzle-orm");
    const { db } = getDb();
    // SAFETY: registerNokia() above always creates (or has already created, in an earlier
    // test sharing this process-wide database) exactly this instrument.
    const nokia = db.select().from(instruments).where(eq(instruments.isin, "FI0009000681")).get()!;
    const logCountBefore = db
      .select()
      .from(priceFetchLog)
      .where(eq(priceFetchLog.instrumentId, nokia.id))
      .all().length;

    const row = nordnetRow({
      id: "2002",
      date: "2020-06-15",
      type: "OSTO",
      name: "NOKIA",
      isin: "FI0009000681",
      qty: "100",
      price: "4,15",
      fee: "3,00",
      currency: "EUR",
      amount: "-418,00",
    });

    const commitResponse = await importRoutes["/api/imports/commit"].POST(
      uploadRequest("http://x/api/imports/commit", cookie, nordnetFile(row), accountId),
    );
    expect(commitResponse.status).toBe(201);
    // SAFETY: a 201 from POST /api/imports/commit (asserted above) always returns
    // { importId, inserted, skipped }.
    const commitBody = (await commitResponse.json()) as { inserted: number };
    expect(commitBody.inserted).toBe(1);

    // The fire-and-forget backfill is not awaited by the route (that's the whole point --
    // see fireBackfill's own comment), so give its one synchronous-throw-turned-rejection a
    // moment to settle before asserting on its effect.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const logAfter = db
      .select()
      .from(priceFetchLog)
      .where(eq(priceFetchLog.instrumentId, nokia.id))
      .orderBy(asc(priceFetchLog.id))
      .all();
    expect(logAfter.length).toBeGreaterThan(logCountBefore);
    const newest = logAfter[logAfter.length - 1]!;
    expect(newest.ok).toBe(false);
    expect(newest.message).toContain("Taustatäyttö");
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
    const row = nordnetRow({ id: "3001", date: "2025-01-10", type: "TALLETUS", amount: "500,00" });
    const commitResponse = await importRoutes["/api/imports/commit"].POST(
      uploadRequest("http://x/api/imports/commit", owner.cookie, nordnetFile(row), accountId),
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

// --- POST /api/imports/op-paste/preview and /api/imports/op-paste/commit ---
//
// Task 20 closes the gap Task 11's report flagged: OP's paste has no HTTP
// route at all. Both routes reuse buildPasteDraft -> the same mapRows /
// commitDraft pipeline the file-upload routes use -- the only difference is
// how the raw text is obtained (parseOpPaste, not parseCsv). knownIsins
// alone can never resolve an OP row: it carries no ISIN at all, ever (see
// op-paste.ts), so `knownInstrumentMaps`'s companion `knownNames` map
// (Task 20's change to map.ts) is what lets a *previously registered*
// instrument stop showing up as unknown -- proven directly below, not just
// asserted.

const opPasteText = (): Promise<string> =>
  Bun.file(`${import.meta.dir}/../import/fixtures/op-web-paste-sample.txt`).text();

/**
 * A fresh, schema-valid ISIN per call -- see instruments.test.ts's own
 * `randomIsin` comment for why a hardcoded ISIN would be flaky across this
 * shared, process-wide `instruments` table.
 */
const randomIsin = (country = "FI"): string =>
  `${country}${crypto.randomUUID().replace(/-/g, "").toUpperCase().slice(0, 9)}0`;

/** Registers an instrument by name with a fresh random ISIN -- how the review screen resolves an OP row. */
const registerByName = async (cookie: string, name: string): Promise<void> => {
  const response = await instrumentRoutes["/api/instruments"].POST(
    new Request("http://x/api/instruments", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        isin: randomIsin(),
        ticker: null,
        name,
        kind: "fund",
        currency: "EUR",
        priceSource: "manual",
        sourceKey: name,
      }),
    }),
  );
  if (response.status !== 201) {
    throw new Error(`registerByName(${name}) failed with status ${response.status}`);
  }
};

/** A named contract (not an open `Record<string, string>` dictionary) so `HeadersInit` accepts it either way `cookie` comes out. */
type PasteRequestHeaders = { "content-type": "application/json"; cookie?: string };

const pasteRequestHeaders = (cookie: string | undefined): PasteRequestHeaders =>
  cookie === undefined
    ? { "content-type": "application/json" }
    : { "content-type": "application/json", cookie };

const pasteRequest = (
  url: string,
  cookie: string | undefined,
  text: string | undefined,
  accountId: number | string | undefined,
): Request =>
  new Request(url, {
    method: "POST",
    headers: pasteRequestHeaders(cookie),
    body: JSON.stringify({ text, accountId }),
  });

describe("POST /api/imports/op-paste/preview", () => {
  test("rejects a request with no session", async () => {
    const response = await importRoutes["/api/imports/op-paste/preview"].POST(
      pasteRequest("http://x/api/imports/op-paste/preview", undefined, "x", 1),
    );
    expect(response.status).toBe(401);
  });

  test("rejects an account the caller does not own", async () => {
    const owner = await signUp(`imp-paste-preview-owner-${crypto.randomUUID()}@example.com`);
    const stranger = await signUp(`imp-paste-preview-stranger-${crypto.randomUUID()}@example.com`);
    const accountId = await openAccount(owner.cookie, "op");
    const response = await importRoutes["/api/imports/op-paste/preview"].POST(
      pasteRequest(
        "http://x/api/imports/op-paste/preview",
        stranger.cookie,
        await opPasteText(),
        accountId,
      ),
    );
    expect(response.status).toBe(404);
  });

  test("rejects a request with no text", async () => {
    const { cookie } = await signUp(`imp-paste-preview-notext-${crypto.randomUUID()}@example.com`);
    const accountId = await openAccount(cookie, "op");
    const response = await importRoutes["/api/imports/op-paste/preview"].POST(
      pasteRequest("http://x/api/imports/op-paste/preview", cookie, undefined, accountId),
    );
    expect(response.status).toBe(400);
  });

  test("rejects a request with a missing account id", async () => {
    const { cookie } = await signUp(
      `imp-paste-preview-noaccount-${crypto.randomUUID()}@example.com`,
    );
    const response = await importRoutes["/api/imports/op-paste/preview"].POST(
      pasteRequest("http://x/api/imports/op-paste/preview", cookie, await opPasteText(), undefined),
    );
    expect(response.status).toBe(400);
  });

  test("rejects text whose header block isn't a real OP paste", async () => {
    const { cookie } = await signUp(
      `imp-paste-preview-badheader-${crypto.randomUUID()}@example.com`,
    );
    const accountId = await openAccount(cookie, "op");
    const response = await importRoutes["/api/imports/op-paste/preview"].POST(
      pasteRequest("http://x/api/imports/op-paste/preview", cookie, "not an OP paste\n", accountId),
    );
    expect(response.status).toBe(400);
    // SAFETY: handle()'s HttpError branch (asserted above via status 400)
    // always shapes its body as `{ error }`.
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("otsikkoa");
  });

  test("previews the real OP paste fixture and reports both name-only unresolved instruments", async () => {
    const { cookie } = await signUp(`imp-paste-preview-ok-${crypto.randomUUID()}@example.com`);
    const accountId = await openAccount(cookie, "op");
    const response = await importRoutes["/api/imports/op-paste/preview"].POST(
      pasteRequest("http://x/api/imports/op-paste/preview", cookie, await opPasteText(), accountId),
    );
    expect(response.status).toBe(200);
    // SAFETY: a 200 from POST /api/imports/op-paste/preview (asserted
    // above) always returns { broker, filename, sha256, txns, problems,
    // unknownIsins }.
    const body = (await response.json()) as {
      broker: string;
      txns: unknown[];
      problems: unknown[];
      unknownIsins: Array<{ isin: string | null; name: string }>;
    };
    expect(body.broker).toBe("op");
    expect(body.txns).toHaveLength(4);
    expect(body.problems).toEqual([]);
    expect(body.unknownIsins.map((u) => u.name).sort()).toEqual([
      "ESIMERKKI OYJ",
      "OP-MAAILMA INDEKSI A",
    ]);
    expect(body.unknownIsins.every((u) => u.isin === null)).toBe(true);
  });
});

describe("POST /api/imports/op-paste/commit", () => {
  test("rejects a request with no session", async () => {
    const response = await importRoutes["/api/imports/op-paste/commit"].POST(
      pasteRequest("http://x/api/imports/op-paste/commit", undefined, "x", 1),
    );
    expect(response.status).toBe(401);
  });

  test("refuses to commit while an OP instrument is still unresolved", async () => {
    const { cookie } = await signUp(`imp-paste-commit-unknown-${crypto.randomUUID()}@example.com`);
    const accountId = await openAccount(cookie, "op");
    const response = await importRoutes["/api/imports/op-paste/commit"].POST(
      pasteRequest("http://x/api/imports/op-paste/commit", cookie, await opPasteText(), accountId),
    );
    expect(response.status).toBe(400);
    // SAFETY: handle()'s HttpError branch (asserted above via status 400)
    // always shapes its body as `{ error }`.
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("OP-MAAILMA INDEKSI A");
    expect(body.error).toContain("ESIMERKKI OYJ");
  });

  test("resolving both instruments by name clears them from a fresh preview, then commit and undo both work", async () => {
    const { cookie } = await signUp(`imp-paste-commit-ok-${crypto.randomUUID()}@example.com`);
    const accountId = await openAccount(cookie, "op");
    const text = await opPasteText();

    await registerByName(cookie, "OP-MAAILMA INDEKSI A");
    await registerByName(cookie, "ESIMERKKI OYJ");

    // Proves the knownNames resolution, not just that commit happens to
    // succeed: a second preview of the exact same paste text must now
    // report zero unresolved instruments, purely from the two instruments
    // just registered by name (OP rows never carry an ISIN to match on).
    const previewResponse = await importRoutes["/api/imports/op-paste/preview"].POST(
      pasteRequest("http://x/api/imports/op-paste/preview", cookie, text, accountId),
    );
    // SAFETY: a 200 from this route always returns { unknownIsins, ... }.
    const previewBody = (await previewResponse.json()) as { unknownIsins: unknown[] };
    expect(previewBody.unknownIsins).toEqual([]);

    const commitResponse = await importRoutes["/api/imports/op-paste/commit"].POST(
      pasteRequest("http://x/api/imports/op-paste/commit", cookie, text, accountId),
    );
    expect(commitResponse.status).toBe(201);
    // SAFETY: a 201 from POST /api/imports/op-paste/commit (asserted
    // above) always returns { importId, inserted, skipped }.
    const commitBody = (await commitResponse.json()) as {
      importId: number;
      inserted: number;
      skipped: number;
    };
    expect(commitBody.inserted).toBe(4);
    expect(commitBody.skipped).toBe(0);

    const undoResponse = await importRoutes["/api/imports/:id/undo"].POST(
      new Request(`http://x/api/imports/${commitBody.importId}/undo`, {
        method: "POST",
        headers: { cookie },
      }),
    );
    expect(undoResponse.status).toBe(200);
    expect(await undoResponse.json()).toEqual({ deleted: 4 });
  });
});

// --- GET /api/imports ---
//
// Closes the other half of the gap: undoImport() has worked since Task 12, but there
// was never a way to reach an import's id again after its one-time success toast.
// This route is that missing history listing.

describe("GET /api/imports", () => {
  test("rejects a request with no session", async () => {
    const response = await importRoutes["/api/imports"].GET(new Request("http://x/api/imports"));
    expect(response.status).toBe(401);
  });

  test("never lists another user's imports", async () => {
    const owner = await signUp(`imp-list-owner-${crypto.randomUUID()}@example.com`);
    const stranger = await signUp(`imp-list-stranger-${crypto.randomUUID()}@example.com`);
    const accountId = await openAccount(owner.cookie);
    const row = nordnetRow({ id: "4001", date: "2025-01-10", type: "TALLETUS", amount: "500,00" });
    const commitResponse = await importRoutes["/api/imports/commit"].POST(
      uploadRequest("http://x/api/imports/commit", owner.cookie, nordnetFile(row), accountId),
    );
    expect(commitResponse.status).toBe(201);

    const ownerList = await importRoutes["/api/imports"].GET(
      new Request("http://x/api/imports", { headers: { cookie: owner.cookie } }),
    );
    const strangerList = await importRoutes["/api/imports"].GET(
      new Request("http://x/api/imports", { headers: { cookie: stranger.cookie } }),
    );
    expect(ownerList.status).toBe(200);
    expect(strangerList.status).toBe(200);
    // SAFETY: a 200 from GET /api/imports (asserted above) always returns
    // an array (see the route's own json(rows.map(...)) response).
    const ownerBody = (await ownerList.json()) as unknown[];
    // SAFETY: same as ownerBody above.
    const strangerBody = (await strangerList.json()) as unknown[];
    expect(ownerBody.length).toBeGreaterThan(0);
    expect(strangerBody).toEqual([]);
  });

  test("reports broker kind, filename, insert/skip counts, undone status and newest-first order", async () => {
    const { cookie } = await signUp(`imp-list-ok-${crypto.randomUUID()}@example.com`);
    const accountId = await openAccount(cookie);

    const first = nordnetRow({
      id: "5001",
      date: "2025-01-10",
      type: "TALLETUS",
      amount: "500,00",
    });
    const firstCommit = await importRoutes["/api/imports/commit"].POST(
      uploadRequest(
        "http://x/api/imports/commit",
        cookie,
        nordnetFile(first, "first.csv"),
        accountId,
      ),
    );
    expect(firstCommit.status).toBe(201);
    // SAFETY: a 201 from POST /api/imports/commit always returns { importId, ... }.
    const { importId: firstId } = (await firstCommit.json()) as { importId: number };

    const second = nordnetRow({
      id: "5002",
      date: "2025-01-11",
      type: "TALLETUS",
      amount: "250,00",
    });
    const secondCommit = await importRoutes["/api/imports/commit"].POST(
      uploadRequest(
        "http://x/api/imports/commit",
        cookie,
        nordnetFile(second, "second.csv"),
        accountId,
      ),
    );
    expect(secondCommit.status).toBe(201);
    // SAFETY: same as above.
    const { importId: secondId } = (await secondCommit.json()) as { importId: number };

    // Undo the first one -- the listing must reflect that afterwards.
    const undoResponse = await importRoutes["/api/imports/:id/undo"].POST(
      new Request(`http://x/api/imports/${firstId}/undo`, { method: "POST", headers: { cookie } }),
    );
    expect(undoResponse.status).toBe(200);

    const listResponse = await importRoutes["/api/imports"].GET(
      new Request("http://x/api/imports", { headers: { cookie } }),
    );
    expect(listResponse.status).toBe(200);
    // SAFETY: a 200 from GET /api/imports (asserted above) always returns
    // an array of { id, kind, filename, createdAt, inserted, skipped, undone }.
    const list = (await listResponse.json()) as Array<{
      id: number;
      kind: string;
      filename: string;
      createdAt: string;
      inserted: number;
      skipped: number;
      undone: boolean;
    }>;
    // Newest first: the second commit's row precedes the first's.
    expect(list[0]!.id).toBe(secondId);
    expect(list[1]!.id).toBe(firstId);

    const secondEntry = list.find((r) => r.id === secondId)!;
    expect(secondEntry.kind).toBe("csv_nordnet");
    expect(secondEntry.filename).toBe("second.csv");
    expect(secondEntry.inserted).toBe(1);
    expect(secondEntry.skipped).toBe(0);
    expect(secondEntry.undone).toBe(false);
    // A real ISO 8601 instant, not a pre-formatted date -- the frontend formats it.
    expect(() => new Date(secondEntry.createdAt).toISOString()).not.toThrow();

    const firstEntry = list.find((r) => r.id === firstId)!;
    expect(firstEntry.filename).toBe("first.csv");
    expect(firstEntry.inserted).toBe(1);
    expect(firstEntry.undone).toBe(true);
  });
});

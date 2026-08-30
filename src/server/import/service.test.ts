import { readBytes, readText } from "../files.ts";
import { CreateAccount, openAccount as openAccountRow } from "../accounts.ts";
import { eq } from "drizzle-orm";
import { EUR } from "../../core/money.ts";
import { getDb } from "../db/index.ts";
import { instruments } from "../db/schema.ts";
import { addInstrument } from "../instruments/store.ts";
import { beforeAll, describe, expect, test } from "vitest";
import { z, ZodError } from "zod";
import { HttpError } from "../errors.ts";
import { NORDNET } from "../import/brokers.ts";

// This file exercises the import service (preview/commit/undo) and
// detectBrokerConfig against a real, migrated database and a real Better
// Auth session, mirroring src/server/api/accounts.test.ts's setup —
// including its reliance on ../test-setup.ts (a vitest.config.ts [test]
// preload script) to have already pinned the shared getDb() handle to a
// migrated in-memory database before this file's own code runs. This file
// must NOT call resetDbHandleForTests(), set DATABASE_PATH, or call
// getDb()/migrate() itself — see test-setup.ts's comment for why.
//
// Per-test data is scoped by a fresh crypto.randomUUID()-derived email (and
// therefore a fresh account/instrument set per test) rather than relying
// on any particular starting state, since every test in the process shares
// one in-memory database.

type Service = typeof import("./service.ts");

let auth: (typeof import("../auth.ts"))["auth"];
let service: Service;
let detectBrokerConfig: Service["detectBrokerConfig"];
let UndoInput: Service["UndoInput"];
let PasteBody: Service["PasteBody"];

beforeAll(async () => {
  auth = (await import("../auth.ts")).auth;
  service = await import("./service.ts");
  UndoInput = service.UndoInput;
  PasteBody = service.PasteBody;
  detectBrokerConfig = service.detectBrokerConfig;
});

/**
 * What the caller sees: a value, or the status and message a refusal carries.
 * The status is still the assertion of record -- 404 for someone else's
 * account, 413 for an oversized file -- it just no longer travels in a
 * Response.
 */
type Refusal = { error: string };
type Answer<T> = { status: number; body: T | Refusal };

const answer = async <T>(run: () => T | Promise<T>): Promise<Answer<T>> => {
  try {
    return { status: 200, body: await run() };
  } catch (cause) {
    if (cause instanceof HttpError) return { status: cause.status, body: { error: cause.message } };
    if (cause instanceof ZodError) {
      return { status: 400, body: { error: cause.issues[0]?.message ?? "Virheellinen pyyntö" } };
    }
    throw cause;
  }
};

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

const openAccount = (userId: string, broker: "nordnet" | "op" = "nordnet"): number =>
  openAccountRow(getDb().db, userId, CreateAccount.parse({ name: "Test tili", broker })).id;

const registerNokia = (): void => {
  // Every test file shares one database, so Nokia may already be registered by
  // another. The route this replaced answered 409 and the caller ignored it.
  const existing = getDb()
    .db.select()
    .from(instruments)
    .where(eq(instruments.isin, "FI0009000681"))
    .get();
  if (existing) return;

  addInstrument(getDb().db, {
    isin: "FI0009000681",
    ticker: "NOKIA.HE",
    name: "Nokia",
    kind: "stock",
    currency: EUR,
    priceSource: "yahoo",
    sourceKey: "NOKIA.HE",
  });
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
  portfolio?: string;
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
  c[4] = o.portfolio ?? "11223344";
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

/** http.ts's error envelope, parsed rather than cast. */
const ErrorSchema = z.object({ error: z.string() });

const csvFile = (contents: string, name = "export.csv"): File =>
  new File([contents], name, { type: "text/csv" });

/** A File built directly from bytes, for an already-encoded (e.g. UTF-16LE) body. */
const binaryFile = (bytes: ArrayBuffer, name = "export.csv"): File =>
  new File([bytes], name, { type: "text/csv" });

/** A Nordnet-shaped upload: real header + one real-format row, UTF-16LE-with-BOM encoded. */
const nordnetFile = (row: string, name = "export.csv"): File =>
  binaryFile(nordnetBytes(`${NORDNET_HEADER}\n${row}\n`), name);

/** The same, with several rows -- for a file that spans more than one account. */
const nordnetFileOf = (rows: readonly string[], name = "export.csv"): File =>
  binaryFile(nordnetBytes(`${NORDNET_HEADER}\n${rows.join("\n")}\n`), name);

const uploadForm = (file: File | undefined, accountId: number | string | undefined): FormData => {
  const form = new FormData();
  if (file) form.append("file", file);
  if (accountId !== undefined) form.append("accountId", String(accountId));
  return form;
};

const fixtureBytes = (name: string) =>
  readBytes(`${import.meta.dirname}/../import/fixtures/${name}`);

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
    const text = await readText(
      `${import.meta.dirname}/../import/fixtures/op-web-paste-sample.txt`,
    );
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
  test("refuses a file covering two accounts, naming them, instead of merging them", async () => {
    const { userId, cookie } = await signUp(`imp-multi-${crypto.randomUUID()}@example.com`);
    const accountId = openAccount(userId);

    const response = await answer(() =>
      service.previewUpload(
        userId,
        uploadForm(
          nordnetFileOf([
            nordnetRow({ id: "1", date: "2025-01-10", type: "TALLETUS", amount: "500,00" }),
            nordnetRow({
              id: "2",
              date: "2025-01-11",
              type: "TALLETUS",
              portfolio: "55667788",
              amount: "300,00",
            }),
          ]),
          accountId,
        ),
      ),
    );

    expect(response.status).toBe(400);
    const body = ErrorSchema.parse(response.body);
    // Both account numbers named: the owner has to know which file to re-export.
    expect(body.error).toContain("11223344");
    expect(body.error).toContain("55667788");
  });

  test("rejects an account the caller does not own", async () => {
    const owner = await signUp(`imp-preview-owner-${crypto.randomUUID()}@example.com`);
    const stranger = await signUp(`imp-preview-stranger-${crypto.randomUUID()}@example.com`);
    const accountId = openAccount(owner.userId);

    const response = await answer(() =>
      service.previewUpload(stranger.userId, uploadForm(csvFile(`${NORDNET_HEADER}\n`), accountId)),
    );
    expect(response.status).toBe(404);
  });

  test("rejects a request with no file", async () => {
    const { userId, cookie } = await signUp(
      `imp-preview-nofile-${crypto.randomUUID()}@example.com`,
    );
    const accountId = openAccount(userId);
    const response = await answer(() =>
      service.previewUpload(userId, uploadForm(undefined, accountId)),
    );
    expect(response.status).toBe(400);
  });

  test("rejects a request with a missing account id", async () => {
    const { userId, cookie } = await signUp(
      `imp-preview-noaccount-${crypto.randomUUID()}@example.com`,
    );
    const response = await answer(() =>
      service.previewUpload(userId, uploadForm(csvFile(`${NORDNET_HEADER}\n`), undefined)),
    );
    expect(response.status).toBe(400);
  });

  test("rejects an oversized file with 413", async () => {
    const { userId, cookie } = await signUp(`imp-preview-huge-${crypto.randomUUID()}@example.com`);
    const accountId = openAccount(userId);
    const huge = csvFile(`${NORDNET_HEADER}\n${"x".repeat(6 * 1024 * 1024)}`);
    const response = await answer(() => service.previewUpload(userId, uploadForm(huge, accountId)));
    expect(response.status).toBe(413);
  });

  test("rejects a CSV whose broker cannot be identified", async () => {
    const { userId, cookie } = await signUp(
      `imp-preview-unknown-${crypto.randomUUID()}@example.com`,
    );
    const accountId = openAccount(userId);
    const response = await answer(() =>
      service.previewUpload(userId, uploadForm(csvFile("Date;Amount\n2025-01-01;5\n"), accountId)),
    );
    expect(response.status).toBe(400);
    // SAFETY: handle()'s HttpError branch (asserted above via status 400)
    // always shapes its body as `{ error }`.
    const body = response.body as { error: string };
    expect(body.error).toContain("välittäjää");
  });

  test("previews a real Nordnet export and reports the unresolved isins", async () => {
    const { userId, cookie } = await signUp(`imp-preview-ok-${crypto.randomUUID()}@example.com`);
    const accountId = openAccount(userId);
    const nordnetBytesFile = await fixtureBytes("nordnet-sample.csv");
    const response = await answer(() =>
      service.previewUpload(userId, uploadForm(binaryFile(nordnetBytesFile), accountId)),
    );
    expect(response.status).toBe(200);
    // SAFETY: a 200 from POST /api/imports/preview (asserted above) always
    // returns { broker, filename, sha256, txns, problems, unknownIsins }.
    const body = response.body as {
      broker: string;
      txns: unknown[];
      unknownIsins: Array<{ isin: string | null }>;
    };
    expect(body.broker).toBe("nordnet");
    // 13 data rows in the fixture, one of them (the fractional adjustment's
    // cash-only twin) reported rather than booked -- see brokers.ts's
    // ignoredTypes -- so 12 reach the draft as transactions.
    expect(body.txns).toHaveLength(12);
    // No instrument is pre-registered for this fresh user, so every isin
    // among the mapped rows is unresolved; SE0005993102 (the MYYNTI row)
    // is one of them. VAIHTO's isins never reach unknown-instrument
    // tracking at all -- an unmapped type throws before isin extraction.
    expect(body.unknownIsins.some((u) => u.isin === "SE0005993102")).toBe(true);
  });
});

// --- POST /api/imports/commit ---

describe("POST /api/imports/commit", () => {
  test("rejects an account the caller does not own", async () => {
    const owner = await signUp(`imp-commit-owner-${crypto.randomUUID()}@example.com`);
    const stranger = await signUp(`imp-commit-stranger-${crypto.randomUUID()}@example.com`);
    const accountId = openAccount(owner.userId);
    const response = await answer(() =>
      service.commitUpload(stranger.userId, uploadForm(csvFile(`${NORDNET_HEADER}\n`), accountId)),
    );
    expect(response.status).toBe(404);
  });

  test("refuses to commit a draft with an unresolved isin", async () => {
    const { userId, cookie } = await signUp(
      `imp-commit-unknown-isin-${crypto.randomUUID()}@example.com`,
    );
    const accountId = openAccount(userId);
    const nordnetBytesFile = await fixtureBytes("nordnet-sample.csv");
    const response = await answer(() =>
      service.commitUpload(userId, uploadForm(binaryFile(nordnetBytesFile), accountId)),
    );
    expect(response.status).toBe(400);
    // SAFETY: handle()'s HttpError branch (asserted above via status 400)
    // always shapes its body as `{ error }`.
    const body = response.body as { error: string };
    expect(body.error).toContain("SE0005993102");
  });

  test("commits a clean EUR-only export and undoes it", async () => {
    const { userId, cookie } = await signUp(`imp-commit-ok-${crypto.randomUUID()}@example.com`);
    const accountId = openAccount(userId);
    registerNokia();
    const row = nordnetRow({
      id: "2001",
      date: "2025-01-10",
      type: "OSTO",
      name: "NOKIA",
      isin: "FI0009000681",
      qty: "100",
      price: "4,15",
      fee: "3,00",
      currency: EUR,
      amount: "-418,00",
    });

    const commitResponse = await answer(() =>
      service.commitUpload(userId, uploadForm(nordnetFile(row), accountId)),
    );
    // SAFETY: a successful commit answers with the import it wrote.
    const commitBody = commitResponse.body as {
      importId: number;
      inserted: number;
      skipped: number;
    };
    expect(commitBody.inserted).toBe(1);
    expect(commitBody.skipped).toBe(0);

    const undoResponse = await answer(() => service.undo(userId, commitBody.importId));
    expect(undoResponse.status).toBe(200);
    expect(undoResponse.body).toEqual({ deleted: 1 });
  });

  test("a commit still returns 201 even when the backfill it fires afterwards can't reach any price source", async () => {
    // No fetchImpl is injected anywhere in this test -- the route has no way to accept one
    // (matching how ensureDraftFxRates's ECB fetch is never stubbed through the route either;
    // see this describe block's other EUR-only tests), so the fire-and-forget backfill this
    // commit triggers (src/server/api/imports.ts's `fireBackfill`) hits the real global fetch,
    // which src/server/test-network-guard.ts replaces with one that always throws. This proves
    // the constraint end to end: a commit whose own rows are all perfectly valid must not be
    // reported as failed just because the price source its backfill needs is unreachable.
    const { userId, cookie } = await signUp(
      `imp-commit-backfill-isolated-${crypto.randomUUID()}@example.com`,
    );
    const accountId = openAccount(userId);
    registerNokia();

    const { getDb } = await import("../db/index.ts");
    const { instruments, priceFetchLog } = await import("../db/schema.ts");
    const { asc, eq } = await import("drizzle-orm");
    const { db } = getDb();
    // SAFETY: registerNokia() above always creates (or has already created, in an earlier
    // test sharing this process-wide database) exactly this instrument.
    const nokia = getDb()
      .db.select()
      .from(instruments)
      .where(eq(instruments.isin, "FI0009000681"))
      .get()!;
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
      currency: EUR,
      amount: "-418,00",
    });

    const commitResponse = await answer(() =>
      service.commitUpload(userId, uploadForm(nordnetFile(row), accountId)),
    );
    // SAFETY: as above -- a commit reports how many rows it inserted.
    const commitBody = commitResponse.body as { inserted: number };
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
  test("rejects undoing an import belonging to another user", async () => {
    const owner = await signUp(`imp-undo-owner-${crypto.randomUUID()}@example.com`);
    const stranger = await signUp(`imp-undo-stranger-${crypto.randomUUID()}@example.com`);
    const accountId = openAccount(owner.userId);
    registerNokia();
    const row = nordnetRow({ id: "3001", date: "2025-01-10", type: "TALLETUS", amount: "500,00" });
    const commitResponse = await answer(() =>
      service.commitUpload(owner.userId, uploadForm(nordnetFile(row), accountId)),
    );
    // SAFETY: commit succeeded (the csv above is a plain EUR deposit,
    // nothing to resolve), so the body carries an importId.
    const { importId } = commitResponse.body as { importId: number };

    const undoResponse = await answer(() => service.undo(stranger.userId, importId));
    expect(undoResponse.status).toBe(404);
  });

  test("rejects an import id that is not a positive integer", () => {
    expect(UndoInput.safeParse({ importId: "not-a-number" }).success).toBe(false);
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
  readText(`${import.meta.dirname}/../import/fixtures/op-web-paste-sample.txt`);

/**
 * A fresh, schema-valid ISIN per call -- see instruments.test.ts's own
 * `randomIsin` comment for why a hardcoded ISIN would be flaky across this
 * shared, process-wide `instruments` table.
 */
const randomIsin = (country = "FI"): string =>
  `${country}${crypto.randomUUID().replace(/-/g, "").toUpperCase().slice(0, 9)}0`;

/** Registers an instrument by name with a fresh random ISIN -- how the review screen resolves an OP row. */
const registerByName = (name: string): void => {
  // Throws on a duplicate, which is what the caller wants to hear about.
  addInstrument(getDb().db, {
    isin: randomIsin(),
    ticker: null,
    name,
    kind: "fund",
    currency: EUR,
    priceSource: "manual",
    sourceKey: name,
  });
};

describe("POST /api/imports/op-paste/preview", () => {
  test("rejects an account the caller does not own", async () => {
    const owner = await signUp(`imp-paste-preview-owner-${crypto.randomUUID()}@example.com`);
    const stranger = await signUp(`imp-paste-preview-stranger-${crypto.randomUUID()}@example.com`);
    const accountId = openAccount(owner.userId, "op");
    const text = await opPasteText();
    const response = await answer(() => service.previewPaste(stranger.userId, { text, accountId }));
    expect(response.status).toBe(404);
  });

  test("rejects a request with no text", async () => {
    const { userId, cookie } = await signUp(
      `imp-paste-preview-notext-${crypto.randomUUID()}@example.com`,
    );
    const accountId = openAccount(userId, "op");
    expect(PasteBody.safeParse({ accountId }).success).toBe(false);
  });

  test("rejects a request with a missing account id", async () => {
    const { userId, cookie } = await signUp(
      `imp-paste-preview-noaccount-${crypto.randomUUID()}@example.com`,
    );
    expect(PasteBody.safeParse({ text: await opPasteText() }).success).toBe(false);
  });

  test("rejects text whose header block isn't a real OP paste", async () => {
    const { userId, cookie } = await signUp(
      `imp-paste-preview-badheader-${crypto.randomUUID()}@example.com`,
    );
    const accountId = openAccount(userId, "op");
    const response = await answer(() =>
      service.previewPaste(userId, { text: "not an OP paste\n", accountId: accountId }),
    );
    expect(response.status).toBe(400);
    // SAFETY: handle()'s HttpError branch (asserted above via status 400)
    // always shapes its body as `{ error }`.
    const body = response.body as { error: string };
    expect(body.error).toContain("otsikkoa");
  });

  test("previews the real OP paste fixture and reports both name-only unresolved instruments", async () => {
    const { userId, cookie } = await signUp(
      `imp-paste-preview-ok-${crypto.randomUUID()}@example.com`,
    );
    const accountId = openAccount(userId, "op");
    const text = await opPasteText();
    const response = await answer(() =>
      service.previewPaste(userId, { text, accountId: accountId }),
    );
    expect(response.status).toBe(200);
    // SAFETY: a 200 from POST /api/imports/op-paste/preview (asserted
    // above) always returns { broker, filename, sha256, txns, problems,
    // unknownIsins }.
    const body = response.body as {
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
  test("refuses to commit while an OP instrument is still unresolved", async () => {
    const { userId, cookie } = await signUp(
      `imp-paste-commit-unknown-${crypto.randomUUID()}@example.com`,
    );
    const accountId = openAccount(userId, "op");
    const text = await opPasteText();
    const response = await answer(() =>
      service.commitPaste(userId, { text, accountId: accountId }),
    );
    expect(response.status).toBe(400);
    // SAFETY: handle()'s HttpError branch (asserted above via status 400)
    // always shapes its body as `{ error }`.
    const body = response.body as { error: string };
    expect(body.error).toContain("OP-MAAILMA INDEKSI A");
    expect(body.error).toContain("ESIMERKKI OYJ");
  });

  test("resolving both instruments by name clears them from a fresh preview, then commit and undo both work", async () => {
    const { userId, cookie } = await signUp(
      `imp-paste-commit-ok-${crypto.randomUUID()}@example.com`,
    );
    const accountId = openAccount(userId, "op");
    const text = await opPasteText();

    registerByName("OP-MAAILMA INDEKSI A");
    registerByName("ESIMERKKI OYJ");

    // Proves the knownNames resolution, not just that commit happens to
    // succeed: a second preview of the exact same paste text must now
    // report zero unresolved instruments, purely from the two instruments
    // just registered by name (OP rows never carry an ISIN to match on).
    const previewResponse = await answer(() =>
      service.previewPaste(userId, { text: text, accountId: accountId }),
    );
    // SAFETY: a 200 from this route always returns { unknownIsins, ... }.
    const previewBody = previewResponse.body as { unknownIsins: unknown[] };
    expect(previewBody.unknownIsins).toEqual([]);

    const commitResponse = await answer(() =>
      service.commitPaste(userId, { text: text, accountId: accountId }),
    );
    // SAFETY: a successful commit answers with the import it wrote.
    const commitBody = commitResponse.body as {
      importId: number;
      inserted: number;
      skipped: number;
    };
    expect(commitBody.inserted).toBe(4);
    expect(commitBody.skipped).toBe(0);

    const undoResponse = await answer(() => service.undo(userId, commitBody.importId));
    expect(undoResponse.status).toBe(200);
    expect(undoResponse.body).toEqual({ deleted: 4 });
  });
});

// --- GET /api/imports ---
//
// Closes the other half of the gap: undoImport() has worked since Task 12, but there
// was never a way to reach an import's id again after its one-time success toast.
// This route is that missing history listing.

describe("GET /api/imports", () => {
  test("never lists another user's imports", async () => {
    const owner = await signUp(`imp-list-owner-${crypto.randomUUID()}@example.com`);
    const stranger = await signUp(`imp-list-stranger-${crypto.randomUUID()}@example.com`);
    const accountId = openAccount(owner.userId);
    const row = nordnetRow({ id: "4001", date: "2025-01-10", type: "TALLETUS", amount: "500,00" });
    const commitResponse = await answer(() =>
      service.commitUpload(owner.userId, uploadForm(nordnetFile(row), accountId)),
    );
    const ownerList = await answer(() => service.listImports(owner.userId));
    const strangerList = await answer(() => service.listImports(stranger.userId));
    expect(ownerList.status).toBe(200);
    expect(strangerList.status).toBe(200);
    // SAFETY: a 200 from GET /api/imports (asserted above) always returns
    // an array (see the route's own json(rows.map(...)) response).
    const ownerBody = ownerList.body as unknown[];
    // SAFETY: same as ownerBody above.
    const strangerBody = strangerList.body as unknown[];
    expect(ownerBody.length).toBeGreaterThan(0);
    expect(strangerBody).toEqual([]);
  });

  test("reports broker kind, filename, insert/skip counts, undone status and newest-first order", async () => {
    const { userId, cookie } = await signUp(`imp-list-ok-${crypto.randomUUID()}@example.com`);
    const accountId = openAccount(userId);

    const first = nordnetRow({
      id: "5001",
      date: "2025-01-10",
      type: "TALLETUS",
      amount: "500,00",
    });
    const firstCommit = await answer(() =>
      service.commitUpload(userId, uploadForm(nordnetFile(first, "first.csv"), accountId)),
    );
    // SAFETY: a successful commit answers with the row it wrote.
    const { importId: firstId } = firstCommit.body as { importId: number };

    const second = nordnetRow({
      id: "5002",
      date: "2025-01-11",
      type: "TALLETUS",
      amount: "250,00",
    });
    const secondCommit = await answer(() =>
      service.commitUpload(userId, uploadForm(nordnetFile(second, "second.csv"), accountId)),
    );
    // SAFETY: as above.
    const { importId: secondId } = secondCommit.body as { importId: number };

    // Undo the first one -- the listing must reflect that afterwards.
    const undoResponse = await answer(() => service.undo(userId, firstId));
    expect(undoResponse.status).toBe(200);

    const listResponse = await answer(() => service.listImports(userId));
    expect(listResponse.status).toBe(200);
    // SAFETY: a 200 from GET /api/imports (asserted above) always returns
    // an array of { id, kind, filename, createdAt, inserted, skipped, undone }.
    const list = listResponse.body as Array<{
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

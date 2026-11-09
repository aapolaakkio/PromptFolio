import { readBytes, readText } from "../files.ts";
import { CreateAccount, openAccount as openAccountRow } from "../accounts.ts";
import { eq } from "drizzle-orm";
import { EUR } from "../../core/money.ts";
import { db } from "../db/index.ts";
import { instruments, transactions, yahooGate } from "../db/schema.ts";
import { addInstrument } from "../instruments/store.ts";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { z, ZodError } from "zod";
import { HttpError } from "../errors.ts";
import { NORDNET_TABLE_RECIPE, OP_PASTE_RECIPE } from "./recipe/broker-reference.ts";
import type { DraftBody } from "./txn-draft.ts";

// This file exercises the import service (preview/commit/undo) and
// the recipe reader against a real, migrated database and a real Better
// Auth session, mirroring src/server/accounts.test.ts's setup —
// including its reliance on ../test-setup.ts (a vitest.config.ts [test]
// preload script) to have already pinned the shared database to a
// migrated in-memory database before this file's own code runs. This file
// must NOT call resetDbHandleForTests(), set DATABASE_PATH, or call
// the shared database itself — see test-setup.ts's comment for why.
//
// Per-test data is scoped by a fresh crypto.randomUUID()-derived email (and
// therefore a fresh account/instrument set per test) rather than relying
// on any particular starting state, since every test in the process shares
// one in-memory database.

type Service = typeof import("./service.ts");

/**
 * A model that describes a table as Nordnet's export and one-value-per-line
 * text as OP's paste -- the two layouts this file's fixtures use.
 */
const nordnetReader = {
  run: (params: { readonly messages: readonly { readonly content: string }[] }) =>
    Promise.resolve({
      text: JSON.stringify(
        params.messages[0]?.content.includes("omalla rivillään")
          ? OP_PASTE_RECIPE
          : NORDNET_TABLE_RECIPE,
      ),
      toolCalls: [],
    }),
};

let auth: ReturnType<(typeof import("../auth.ts"))["getAuth"]>;
let service: Service;
let UndoInput: Service["UndoInput"];
let PasteBody: Service["PasteBody"];

beforeAll(async () => {
  auth = (await import("../auth.ts")).getAuth();
  service = await import("./service.ts");
  UndoInput = service.UndoInput;
  PasteBody = service.PasteBody;
  // Every broker file is read by a recipe; this stands in for the model.
  service._setReaderClient(nordnetReader);
  // Every unknown instrument is looked up; by default nothing is found.
  service._setLookupFetch(async () => new Response("", { status: 404 }));
  service._setQuoteSpacingMs(0);
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

/** Preview, then commit what the preview produced -- the path the screen takes. */
const commitPreviewed = async (
  userId: string,
  previewed: Answer<unknown>,
  accountId: number,
  kind: "csv" | "paste" | "pdf",
) => {
  if (previewed.status !== 200) return previewed;
  // SAFETY: a 200 from either preview is `{ broker, filename, sha256, txns, problems, unknownIsins }`,
  // where txns/problems/unknownIsins are already draft-shaped -- the same shape commitDraftBody's own
  // DraftBody validates, which is why the cast is typed against it rather than `unknown[]`.
  const body = previewed.body as {
    filename: string;
    sha256: string;
    txns: DraftBody["txns"];
    problems: DraftBody["problems"];
    unknownIsins: DraftBody["unknownIsins"];
  };
  return answer(() =>
    service.commitDraftBody(userId, {
      accountId,
      filename: body.filename,
      sha256: body.sha256,
      kind,
      draft: { txns: body.txns, problems: body.problems, unknownIsins: body.unknownIsins },
    }),
  );
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

const openAccount = async (userId: string, broker: "nordnet" | "op" = "nordnet"): Promise<number> =>
  (await openAccountRow(db, userId, CreateAccount.parse({ name: "Test tili", broker }))).id;

const registerNokia = async (): Promise<void> => {
  // Every test file shares one database, so Nokia may already be registered by
  // another. The route this replaced answered 409 and the caller ignored it.
  const existing = await db
    .select()
    .from(instruments)
    .where(eq(instruments.isin, "FI0009000681"))
    .get();
  if (existing) return;

  await addInstrument(db, {
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

// --- POST /api/imports/preview ---

describe("POST /api/imports/preview", () => {
  test("refuses a file covering two accounts, naming them, instead of merging them", async () => {
    const { userId } = await signUp(`imp-multi-${crypto.randomUUID()}@example.com`);
    const accountId = await openAccount(userId);

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
    const accountId = await openAccount(owner.userId);

    const response = await answer(() =>
      service.previewUpload(stranger.userId, uploadForm(csvFile(`${NORDNET_HEADER}\n`), accountId)),
    );
    expect(response.status).toBe(404);
  });

  test("rejects a request with no file", async () => {
    const { userId } = await signUp(`imp-preview-nofile-${crypto.randomUUID()}@example.com`);
    const accountId = await openAccount(userId);
    const response = await answer(() =>
      service.previewUpload(userId, uploadForm(undefined, accountId)),
    );
    expect(response.status).toBe(400);
  });

  test("rejects a request with a missing account id", async () => {
    const { userId } = await signUp(`imp-preview-noaccount-${crypto.randomUUID()}@example.com`);
    const response = await answer(() =>
      service.previewUpload(userId, uploadForm(csvFile(`${NORDNET_HEADER}\n`), undefined)),
    );
    expect(response.status).toBe(400);
  });

  test("rejects an oversized file with 413", async () => {
    const { userId } = await signUp(`imp-preview-huge-${crypto.randomUUID()}@example.com`);
    const accountId = await openAccount(userId);
    const huge = csvFile(`${NORDNET_HEADER}\n${"x".repeat(6 * 1024 * 1024)}`);
    const response = await answer(() => service.previewUpload(userId, uploadForm(huge, accountId)));
    expect(response.status).toBe(413);
  });

  test("rejects a CSV the model cannot describe", async () => {
    const { userId } = await signUp(`imp-preview-unknown-${crypto.randomUUID()}@example.com`);
    const accountId = await openAccount(userId);
    const response = await answer(() =>
      service.previewUpload(userId, uploadForm(csvFile("Date;Amount\n2025-01-01;5\n"), accountId)),
    );
    expect(response.status).toBe(400);
    // SAFETY: handle()'s HttpError branch (asserted above via status 400)
    // always shapes its body as `{ error }`.
    const body = response.body as { error: string };
    expect(body.error).toContain("tapahtumaluetteloksi");
  });

  test("previews a real Nordnet export and reports the unresolved isins", async () => {
    const { userId } = await signUp(`imp-preview-ok-${crypto.randomUUID()}@example.com`);
    const accountId = await openAccount(userId);
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
    expect(body.broker).toBe("csv");
    // 13 data rows in the fixture, one of them (the fractional adjustment's
    // cash-only twin) reported rather than booked -- see fixtures/broker-mappings.ts's
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
    const accountId = await openAccount(owner.userId);
    // A header alone is no transaction list: a recipe has nothing to read.
    const sample = await fixtureBytes("nordnet-sample.csv");
    const previewed = await answer(() =>
      service.previewUpload(owner.userId, uploadForm(binaryFile(sample), accountId)),
    );
    expect(previewed.status).toBe(200);
    const response = await commitPreviewed(stranger.userId, previewed, accountId, "csv");
    expect(response.status).toBe(404);
  });

  test("refuses to commit a draft with an unresolved isin", async () => {
    const { userId } = await signUp(`imp-commit-unknown-isin-${crypto.randomUUID()}@example.com`);
    const accountId = await openAccount(userId);
    const nordnetBytesFile = await fixtureBytes("nordnet-sample.csv");
    const previewed = await answer(() =>
      service.previewUpload(userId, uploadForm(binaryFile(nordnetBytesFile), accountId)),
    );
    const response = await commitPreviewed(userId, previewed, accountId, "csv");
    expect(response.status).toBe(400);
    // SAFETY: handle()'s HttpError branch (asserted above via status 400)
    // always shapes its body as `{ error }`.
    const body = response.body as { error: string };
    expect(body.error).toContain("SE0005993102");
  });

  test("commits a clean EUR-only export and undoes it", async () => {
    const { userId } = await signUp(`imp-commit-ok-${crypto.randomUUID()}@example.com`);
    const accountId = await openAccount(userId);
    await registerNokia();
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
    // commit triggers (src/server/import/service.ts's `fireBackfill`) hits the real global fetch,
    // which src/server/test-network-guard.ts replaces with one that always throws. This proves
    // the constraint end to end: a commit whose own rows are all perfectly valid must not be
    // reported as failed just because the price source its backfill needs is unreachable.
    const { userId } = await signUp(
      `imp-commit-backfill-isolated-${crypto.randomUUID()}@example.com`,
    );
    const accountId = await openAccount(userId);
    await registerNokia();

    const { db } = await import("../db/index.ts");
    const { instruments, priceFetchLog } = await import("../db/schema.ts");
    const { asc, eq } = await import("drizzle-orm");
    // SAFETY: registerNokia() above always creates (or has already created, in an earlier
    // test sharing this process-wide database) exactly this instrument.
    const nokia = await db
      .select()
      .from(instruments)
      .where(eq(instruments.isin, "FI0009000681"))
      .get();
    if (nokia === undefined) throw new Error("registerNokia() did not create the instrument");
    const logCountBefore = (
      await db.select().from(priceFetchLog).where(eq(priceFetchLog.instrumentId, nokia.id)).all()
    ).length;

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

    const previewed = await answer(() =>
      service.previewUpload(userId, uploadForm(nordnetFile(row), accountId)),
    );
    const commitResponse = await commitPreviewed(userId, previewed, accountId, "csv");
    // SAFETY: as above -- a commit reports how many rows it inserted.
    const commitBody = commitResponse.body as { inserted: number };
    expect(commitBody.inserted).toBe(1);

    // The fire-and-forget backfill is not awaited by the route (that's the whole point --
    // see fireBackfill's own comment), so poll for its effect rather than sleep a fixed
    // time: through the D1 proxy the refused fetch takes more than a tick to be logged.
    const readLog = () =>
      db
        .select()
        .from(priceFetchLog)
        .where(eq(priceFetchLog.instrumentId, nokia.id))
        .orderBy(asc(priceFetchLog.id))
        .all();
    let logAfter = await readLog();
    for (let tries = 0; tries < 100 && logAfter.length <= logCountBefore; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      logAfter = await readLog();
    }
    expect(logAfter.length).toBeGreaterThan(logCountBefore);
    const newest = logAfter[logAfter.length - 1]!;
    expect(newest.ok).toBe(false);
    expect(newest.message).toContain("Taustatäyttö");
  });
});

// --- instruments added by the import itself ---

/** A fresh, ISIN-shaped code per call: the suite shares one database. */
const freshIsin = (): string =>
  `XS${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}${Math.floor(Math.random() * 10)}`;

/** Yahoo knows `symbol` in EUR; OpenFIGI and everything else answers 404. */
const yahooKnows =
  (symbol: string) =>
  async (input: string | URL | Request): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes("finance/search")) {
      return new Response(JSON.stringify({ quotes: [{ symbol, quoteType: "EQUITY" }] }));
    }
    if (url.includes(`chart/${symbol}`)) {
      return new Response(
        JSON.stringify({
          chart: {
            result: [
              {
                meta: { currency: "EUR" },
                timestamp: [1_700_000_000],
                indicators: { quote: [{ close: [1.5] }] },
              },
            ],
          },
        }),
      );
    }
    return new Response("", { status: 404 });
  };

const nothingFound = async (): Promise<Response> => new Response("", { status: 404 });

describe("an import with an instrument nobody has added yet", () => {
  beforeAll(() => {
    service._setLookupFetch(nothingFound);
    service._setQuoteSpacingMs(0);
  });
  afterEach(async () => {
    service._setLookupFetch(nothingFound);
    await db.delete(yahooGate).run();
  });

  const previewOne = async (userId: string, accountId: number, isin: string) =>
    answer(() =>
      service.previewUpload(
        userId,
        uploadForm(
          nordnetFile(
            nordnetRow({
              id: `auto-${isin}`,
              date: "2025-02-03",
              type: "OSTO",
              name: "AUTO OYJ",
              isin,
              qty: "10",
              price: "1,50",
              currency: EUR,
              amount: "-15,00",
            }),
          ),
          accountId,
        ),
      ),
    );

  const linkedRows = async (importId: number) =>
    db
      .select({ instrumentId: transactions.instrumentId })
      .from(transactions)
      .where(eq(transactions.importId, importId))
      .all();

  test("a preview with a new ISIN commits without any form", async () => {
    const { userId } = await signUp(`imp-auto-found-${crypto.randomUUID()}@example.com`);
    const accountId = await openAccount(userId);
    const isin = freshIsin();
    service._setLookupFetch(yahooKnows("AUTO.HE"));

    const previewed = await previewOne(userId, accountId, isin);
    // SAFETY: a 200 preview carries the draft, `added` included.
    const body = previewed.body as {
      unknownIsins: unknown[];
      added: Array<{ isin: string; sourceKey: string | null; pending: boolean }>;
    };
    expect(body.unknownIsins).toEqual([]);
    expect(body.added).toMatchObject([{ isin, sourceKey: "AUTO.HE", pending: false }]);
    // The preview only remembers the lookup; the instrument is created at commit.
    expect(
      await db.select().from(instruments).where(eq(instruments.isin, isin)).get(),
    ).toBeUndefined();

    const committed = await commitPreviewed(userId, previewed, accountId, "csv");
    expect(committed.status).toBe(200);
    // SAFETY: a 200 commit answers with the import it wrote.
    const result = committed.body as { importId: number; inserted: number };
    expect(result.inserted).toBe(1);
    const created = await db.select().from(instruments).where(eq(instruments.isin, isin)).get();
    expect(created).toMatchObject({ priceSource: "yahoo", sourceKey: "AUTO.HE" });
    expect(await linkedRows(result.importId)).toEqual([{ instrumentId: created?.id }]);
  });

  test("a preview while Yahoo is paused still commits, as pending", async () => {
    const { userId } = await signUp(`imp-auto-paused-${crypto.randomUUID()}@example.com`);
    const accountId = await openAccount(userId);
    const isin = freshIsin();
    await db
      .insert(yahooGate)
      .values({ id: 1, pausedUntil: Date.now() + 3_600_000, backoffMs: 900_000 })
      .onConflictDoUpdate({
        target: yahooGate.id,
        set: { pausedUntil: Date.now() + 3_600_000, backoffMs: 900_000 },
      });

    const previewed = await previewOne(userId, accountId, isin);
    // SAFETY: a 200 preview carries the draft, `added` included.
    const body = previewed.body as {
      unknownIsins: unknown[];
      added: Array<{ isin: string; pending: boolean }>;
    };
    expect(body.unknownIsins).toEqual([]);
    expect(body.added).toMatchObject([{ isin, pending: true }]);

    const committed = await commitPreviewed(userId, previewed, accountId, "csv");
    expect(committed.status).toBe(200);
    // SAFETY: a 200 commit answers with the import it wrote.
    const result = committed.body as { importId: number };
    const created = await db.select().from(instruments).where(eq(instruments.isin, isin)).get();
    expect(created).toMatchObject({
      priceSource: "manual",
      sourceKey: isin,
      lookupStatus: "pending",
    });
    expect(await linkedRows(result.importId)).toEqual([{ instrumentId: created?.id }]);
  });
});

// --- POST /api/imports/:id/undo ---

describe("POST /api/imports/:id/undo", () => {
  test("rejects undoing an import belonging to another user", async () => {
    const owner = await signUp(`imp-undo-owner-${crypto.randomUUID()}@example.com`);
    const stranger = await signUp(`imp-undo-stranger-${crypto.randomUUID()}@example.com`);
    const accountId = await openAccount(owner.userId);
    await registerNokia();
    const row = nordnetRow({ id: "3001", date: "2025-01-10", type: "TALLETUS", amount: "500,00" });
    const previewed = await answer(() =>
      service.previewUpload(owner.userId, uploadForm(nordnetFile(row), accountId)),
    );
    const commitResponse = await commitPreviewed(owner.userId, previewed, accountId, "csv");
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
// how the raw text is read (a record recipe, not a table one). knownIsins
// alone can never resolve an OP row: it carries no ISIN at all, ever, so `knownInstrumentMaps`'s companion `knownNames` map
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
const registerByName = async (name: string): Promise<void> => {
  // Throws on a duplicate, which is what the caller wants to hear about.
  await addInstrument(db, {
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
    const accountId = await openAccount(owner.userId, "op");
    const text = await opPasteText();
    const response = await answer(() => service.previewPaste(stranger.userId, { text, accountId }));
    expect(response.status).toBe(404);
  });

  test("rejects a request with no text", async () => {
    const { userId } = await signUp(`imp-paste-preview-notext-${crypto.randomUUID()}@example.com`);
    const accountId = await openAccount(userId, "op");
    expect(PasteBody.safeParse({ accountId }).success).toBe(false);
  });

  test("rejects a request with a missing account id", async () => {
    await signUp(`imp-paste-preview-noaccount-${crypto.randomUUID()}@example.com`);
    expect(PasteBody.safeParse({ text: await opPasteText() }).success).toBe(false);
  });

  test("rejects text no recipe can read as transactions", async () => {
    const { userId } = await signUp(
      `imp-paste-preview-badheader-${crypto.randomUUID()}@example.com`,
    );
    const accountId = await openAccount(userId, "op");
    const response = await answer(() =>
      service.previewPaste(userId, { text: "not an OP paste\n", accountId: accountId }),
    );
    expect(response.status).toBe(400);
    // SAFETY: handle()'s HttpError branch (asserted above via status 400)
    // always shapes its body as `{ error }`.
    const body = response.body as { error: string };
    expect(body.error).toContain("tapahtumaluetteloksi");
  });

  test("previews the real OP paste fixture and reports both name-only unresolved instruments", async () => {
    const { userId } = await signUp(`imp-paste-preview-ok-${crypto.randomUUID()}@example.com`);
    const accountId = await openAccount(userId, "op");
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
    expect(body.broker).toBe("paste");
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
    const { userId } = await signUp(`imp-paste-commit-unknown-${crypto.randomUUID()}@example.com`);
    const accountId = await openAccount(userId, "op");
    const text = await opPasteText();
    const previewed = await answer(() => service.previewPaste(userId, { text, accountId }));
    const response = await commitPreviewed(userId, previewed, accountId, "paste");
    expect(response.status).toBe(400);
    // SAFETY: handle()'s HttpError branch (asserted above via status 400)
    // always shapes its body as `{ error }`.
    const body = response.body as { error: string };
    expect(body.error).toContain("OP-MAAILMA INDEKSI A");
    expect(body.error).toContain("ESIMERKKI OYJ");
  });

  test("resolving both instruments by name clears them from a fresh preview, then commit and undo both work", async () => {
    const { userId } = await signUp(`imp-paste-commit-ok-${crypto.randomUUID()}@example.com`);
    const accountId = await openAccount(userId, "op");
    const text = await opPasteText();

    await registerByName("OP-MAAILMA INDEKSI A");
    await registerByName("ESIMERKKI OYJ");

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

// --- POST /api/imports/preview reading a broker PDF ---
//
// Task 7 adds a third source alongside the Nordnet CSV and the OP paste: a
// broker PDF, read page by page by a model. `_setReaderClient` swaps in a
// scripted ChatClient so this never reaches Workers AI. The commit half is
// identical to the CSV/paste path: `commitDraftBody` takes the reviewed
// draft, not the file.

describe("a broker PDF", () => {
  /**
   * A record recipe for the statement fixture's text: its two transactions,
   * each a dated signed line followed by its detail lines, with the opening
   * and closing balances dropped.
   */
  const statementRecipe = {
    kind: "broker-record",
    skip: [
      String.raw`^(?:Tilinumero .*|BIC .*|Kirjaus-|päivä|Arvopäivä|Määrä,|euroa|Selitys|Maksunsaaja/maksaja|Viesti|Viite Arkistointitunnus|Saajan tilinumero|Saajan pankin BIC)$`,
      String.raw`Saldo \d`,
      String.raw`^(?:Tiliote|Käyttötili|Ajalta)$`,
      String.raw`^\d{1,2}\.\d{1,2}\.\d{4} - `,
      String.raw`^\d+ \(\d+\)$`,
    ],
    recordStart: String.raw`^\d{1,2}\.\d{1,2}\.\d{4} [−+-]`,
    record: String.raw`(?<tradeDate>\d{1,2}\.\d{1,2}\.\d{4}) (?<amount>[−+-][\d ]*\d,\d{2}) (?<type>[A-ZÄÖ]+)(?<note>[\s\S]*)`,
    dateFormat: "d.m.yyyy",
    money: { decimal: ",", thousands: " ", negative: "leading", twoColumn: false },
    unsignedAmount: false,
    types: [
      { label: "PKORTTIMAKSU", type: "WITHDRAWAL", reason: null, sign: null },
      { label: "PANO", type: "DEPOSIT", reason: null, sign: null },
    ],
  };
  const statementReader = {
    run: () => Promise.resolve({ text: JSON.stringify(statementRecipe), toolCalls: [] }),
  };

  // The scripted client is set per test below; reset afterwards so a later
  // test in this file that uploads a PDF-shaped file never silently reuses
  // whichever reading the last PDF test scripted.
  afterEach(() => {
    service._setReaderClient(nordnetReader);
  });

  test("previews through the reader and commits like any draft", async () => {
    service._setReaderClient(statementReader);
    const { userId } = await signUp(`imp-pdf-${crypto.randomUUID()}@example.com`);
    const accountId = await openAccount(userId);
    await registerNokia();
    const bytes = await readBytes(`${import.meta.dirname}/fixtures/op-statement-sample.pdf`);
    const form = new FormData();
    form.set("file", new File([bytes], "tapahtumat.pdf"));
    form.set("accountId", String(accountId));

    const previewed = await answer(() => service.previewUpload(userId, form));
    expect(previewed.status).toBe(200);
    // SAFETY: a 200 preview carries the draft.
    expect((previewed.body as { broker: string; txns: unknown[] }).broker).toBe("pdf");

    const committed = await commitPreviewed(userId, previewed, accountId, "pdf");
    expect(committed.status).toBe(200);
    // SAFETY: a 200 commit reports counts.
    expect((committed.body as { inserted: number }).inserted).toBe(2);
  });

  test("an edited draft is what commits", async () => {
    service._setReaderClient(statementReader);
    const { userId } = await signUp(`imp-pdf-edit-${crypto.randomUUID()}@example.com`);
    const accountId = await openAccount(userId);
    await registerNokia();
    const bytes = await readBytes(`${import.meta.dirname}/fixtures/op-statement-sample.pdf`);
    const form = new FormData();
    form.set("file", new File([bytes], "tapahtumat.pdf"));
    form.set("accountId", String(accountId));
    const previewed = await answer(() => service.previewUpload(userId, form));
    // SAFETY: a 200 preview carries the draft, in the same shape commitPreviewed's own cast trusts.
    const body = previewed.body as {
      filename: string;
      sha256: string;
      txns: DraftBody["txns"];
      problems: DraftBody["problems"];
      unknownIsins: DraftBody["unknownIsins"];
    };
    const edited = { ...body, txns: [{ ...body.txns[0], amount: -50_000 }] };
    const committed = await commitPreviewed(
      userId,
      { status: 200, body: edited },
      accountId,
      "pdf",
    );
    expect(committed.status).toBe(200);
    const stored = await db.select().from(transactions).all();
    expect(stored.at(-1)?.amount).toBe(-50_000);
  });

  // Guards the contract, not one line of it: the account a row lands on comes
  // from the request either way (see commitDraftBody).
  test("an edited row cannot move itself to another account", async () => {
    service._setReaderClient(statementReader);
    const { userId } = await signUp(`imp-pdf-foreign-account-${crypto.randomUUID()}@example.com`);
    const accountId = await openAccount(userId);
    const otherAccountId = await openAccount(userId);
    await registerNokia();
    const bytes = await readBytes(`${import.meta.dirname}/fixtures/op-statement-sample.pdf`);
    const form = new FormData();
    form.set("file", new File([bytes], "tapahtumat.pdf"));
    form.set("accountId", String(accountId));
    const previewed = await answer(() => service.previewUpload(userId, form));
    // SAFETY: a 200 preview carries the draft, in the same shape commitPreviewed's own cast trusts.
    const body = previewed.body as {
      filename: string;
      sha256: string;
      txns: DraftBody["txns"];
      problems: DraftBody["problems"];
      unknownIsins: DraftBody["unknownIsins"];
    };
    // The row claims a different account than the request names -- the
    // request's accountId must win, proving commitDraftBody's overwrite
    // (not just trusting whatever the edited row carries).
    const edited = {
      ...body,
      txns: [{ ...body.txns[0], accountId: otherAccountId }],
    };
    const committed = await commitPreviewed(
      userId,
      { status: 200, body: edited },
      accountId,
      "pdf",
    );
    expect(committed.status).toBe(200);
    const stored = await db.select().from(transactions).all();
    const last = stored.at(-1);
    expect(last?.accountId).toBe(accountId);
    expect(last?.accountId).not.toBe(otherAccountId);
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
    const accountId = await openAccount(owner.userId);
    const row = nordnetRow({ id: "4001", date: "2025-01-10", type: "TALLETUS", amount: "500,00" });
    const previewed = await answer(() =>
      service.previewUpload(owner.userId, uploadForm(nordnetFile(row), accountId)),
    );
    await commitPreviewed(owner.userId, previewed, accountId, "csv");
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
    const { userId } = await signUp(`imp-list-ok-${crypto.randomUUID()}@example.com`);
    const accountId = await openAccount(userId);

    const first = nordnetRow({
      id: "5001",
      date: "2025-01-10",
      type: "TALLETUS",
      amount: "500,00",
    });
    const firstPreviewed = await answer(() =>
      service.previewUpload(userId, uploadForm(nordnetFile(first, "first.csv"), accountId)),
    );
    const firstCommit = await commitPreviewed(userId, firstPreviewed, accountId, "csv");
    // SAFETY: a successful commit answers with the row it wrote.
    const { importId: firstId } = firstCommit.body as { importId: number };

    const second = nordnetRow({
      id: "5002",
      date: "2025-01-11",
      type: "TALLETUS",
      amount: "250,00",
    });
    const secondPreviewed = await answer(() =>
      service.previewUpload(userId, uploadForm(nordnetFile(second, "second.csv"), accountId)),
    );
    const secondCommit = await commitPreviewed(userId, secondPreviewed, accountId, "csv");
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
    expect(secondEntry.kind).toBe("csv");
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

import { APIConnectionError } from "@anthropic-ai/sdk";
import { readBytes, readText } from "../files.ts";
import { CreateAccount, openAccount as openAccountRow } from "../accounts.ts";
import { eq, inArray } from "drizzle-orm";
import { EUR } from "../../core/money.ts";
import { db } from "../db/index.ts";
import { instrumentLookups, instruments, transactions, yahooGate } from "../db/schema.ts";
import { lookupKey } from "../instruments/lookup-cache.ts";
import { addInstrument } from "../instruments/store.ts";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { z, ZodError } from "zod";
import { HttpError } from "../errors.ts";
import { NORDNET_TABLE_RECIPE, OP_PASTE_RECIPE } from "./recipe/broker-reference.ts";
import type { DraftBody } from "./txn-draft.ts";

type Service = typeof import("./service.ts");

const nordnetReader = {
  run: (params: { readonly messages: readonly { readonly content: string }[] }) =>
    Promise.resolve({
      text: JSON.stringify(
        params.messages[0]?.content.includes("on its own line")
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
  service._setReaderClient(nordnetReader);
  service._setLookupFetch(async () => new Response("", { status: 404 }));
  service._setQuoteSpacingMs(0);
  service._setPageLookup(null);
});

type Refusal = { error: string };
type Answer<T> = { status: number; body: T | Refusal };

const answer = async <T>(run: () => T | Promise<T>): Promise<Answer<T>> => {
  try {
    return { status: 200, body: await run() };
  } catch (cause) {
    if (cause instanceof HttpError) return { status: cause.status, body: { error: cause.message } };
    if (cause instanceof ZodError) {
      return { status: 400, body: { error: cause.issues[0]?.message ?? "Invalid request" } };
    }
    throw cause;
  }
};

const commitPreviewed = async (
  userId: string,
  previewed: Answer<unknown>,
  accountId: number,
  kind: "csv" | "paste" | "pdf",
) => {
  if (previewed.status !== 200) return previewed;
  // SAFETY: the body has the shape the route returns.
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
  // SAFETY: the body has the shape the route returns.
  const body = (await response.json()) as { user: { id: string } };
  return { userId: body.user.id, cookie: sessionCookieFrom(response) };
};

const openAccount = async (userId: string, broker: "nordnet" | "op" = "nordnet"): Promise<number> =>
  (await openAccountRow(db, userId, CreateAccount.parse({ name: "Test account", broker }))).id;

const registerNokia = async (): Promise<void> => {
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

const ErrorSchema = z.object({ error: z.string() });

const csvFile = (contents: string, name = "export.csv"): File =>
  new File([contents], name, { type: "text/csv" });

const binaryFile = (bytes: ArrayBuffer, name = "export.csv"): File =>
  new File([bytes], name, { type: "text/csv" });

const nordnetFile = (row: string, name = "export.csv"): File =>
  binaryFile(nordnetBytes(`${NORDNET_HEADER}\n${row}\n`), name);

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
    // SAFETY: the body has the shape the route returns.
    const body = response.body as { error: string };
    expect(body.error).toContain("transaction list");
  });

  test("previews a real Nordnet export and reports the unresolved isins", async () => {
    const { userId } = await signUp(`imp-preview-ok-${crypto.randomUUID()}@example.com`);
    const accountId = await openAccount(userId);
    const nordnetBytesFile = await fixtureBytes("nordnet-sample.csv");
    const response = await answer(() =>
      service.previewUpload(userId, uploadForm(binaryFile(nordnetBytesFile), accountId)),
    );
    expect(response.status).toBe(200);
    // SAFETY: the body has the shape the route returns.
    const body = response.body as {
      broker: string;
      txns: unknown[];
      unknownIsins: Array<{ isin: string | null }>;
    };
    expect(body.broker).toBe("csv");
    expect(body.txns).toHaveLength(12);
    expect(body.unknownIsins.some((u) => u.isin === "SE0005993102")).toBe(true);
  });
});

describe("POST /api/imports/commit", () => {
  test("rejects an account the caller does not own", async () => {
    const owner = await signUp(`imp-commit-owner-${crypto.randomUUID()}@example.com`);
    const stranger = await signUp(`imp-commit-stranger-${crypto.randomUUID()}@example.com`);
    const accountId = await openAccount(owner.userId);
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
    // SAFETY: the body has the shape the route returns.
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

    const previewed = await answer(() =>
      service.previewUpload(userId, uploadForm(nordnetFile(row), accountId)),
    );
    const commitResponse = await commitPreviewed(userId, previewed, accountId, "csv");
    // SAFETY: the body has the shape the route returns.
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
    const { userId } = await signUp(
      `imp-commit-backfill-isolated-${crypto.randomUUID()}@example.com`,
    );
    const accountId = await openAccount(userId);
    await registerNokia();

    const { db } = await import("../db/index.ts");
    const { instruments, priceFetchLog } = await import("../db/schema.ts");
    const { asc, eq } = await import("drizzle-orm");

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
    // SAFETY: the body has the shape the route returns.
    const commitBody = commitResponse.body as { inserted: number };
    expect(commitBody.inserted).toBe(1);

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
    expect(newest.message).toContain("Backfill failed");
  });
});

const freshIsin = (): string =>
  `XS${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}${Math.floor(Math.random() * 10)}`;

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
    // SAFETY: the body has the shape the route returns.
    const body = previewed.body as {
      unknownIsins: unknown[];
      added: Array<{ isin: string; sourceKey: string | null; pending: boolean }>;
    };
    expect(body.unknownIsins).toEqual([]);
    expect(body.added).toMatchObject([{ isin, sourceKey: "AUTO.HE", pending: false }]);
    expect(
      await db.select().from(instruments).where(eq(instruments.isin, isin)).get(),
    ).toBeUndefined();

    const committed = await commitPreviewed(userId, previewed, accountId, "csv");
    expect(committed.status).toBe(200);
    // SAFETY: the body has the shape the route returns.
    const result = committed.body as { importId: number; inserted: number };
    expect(result.inserted).toBe(1);
    const created = await db.select().from(instruments).where(eq(instruments.isin, isin)).get();
    expect(created).toMatchObject({ priceSource: "yahoo", sourceKey: "AUTO.HE" });
    expect(await linkedRows(result.importId)).toEqual([{ instrumentId: created?.id }]);
  });

  test("an OP fund found by the finder commits though the browser drops the row's name", async () => {
    const { userId } = await signUp(`imp-auto-op-${crypto.randomUUID()}@example.com`);
    const accountId = await openAccount(userId, "op");
    const tag = crypto
      .randomUUID()
      .replace(/[^a-f]/g, "")
      .slice(0, 8);
    const fundName = `OP-TESTI${tag.toUpperCase()} INDEKSI A`;
    const pageIsin = randomIsin();
    const pageUrl = `https://example.test/op-test${tag}`;
    const text = (await opPasteText()).replaceAll("OP-MAAILMA INDEKSI A", fundName);
    const keys = [lookupKey(null, fundName), pageIsin];
    const figi = JSON.stringify([{ data: [{ name: fundName, securityType: "Open-End Fund" }] }]);
    const chart = {
      chart: {
        result: [
          {
            meta: { currency: "EUR" },
            timestamp: [1_700_000_000],
            indicators: { quote: [{ close: [1.5] }] },
          },
        ],
      },
    };
    service._setLookupFetch(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith(pageUrl)) return new Response(`<h1>${fundName} ${pageIsin}</h1>`);
      if (url.includes("openfigi")) return new Response(figi);
      if (url.includes("finance/search")) {
        return new Response(JSON.stringify({ quotes: [{ symbol: "0PTEST.F" }] }));
      }
      if (url.includes("chart/0PTEST.F")) return new Response(JSON.stringify(chart));
      return new Response("", { status: 404 });
    });
    const down = (): Promise<never> => Promise.reject(new Error("model unavailable"));
    service._setPageLookup({
      find: async (q) => (q.name === fundName ? { url: pageUrl, isin: pageIsin } : null),
      client: { run: down },
    });

    try {
      const previewed = await answer(() => service.previewPaste(userId, { text, accountId }));
      expect(previewed.status).toBe(200);
      // SAFETY: the body has the shape the route returns.
      const body = previewed.body as {
        sha256: string;
        txns: DraftBody["txns"];
        unknownIsins: DraftBody["unknownIsins"];
        added: Array<{ isin: string; priceSource: string | null }>;
      };
      expect(body.added).toMatchObject([{ isin: pageIsin, priceSource: "yahoo" }]);
      expect(body.unknownIsins.map((u) => u.name)).toEqual(["ESIMERKKI OYJ"]);

      const fundRows = body.txns
        .filter((t) => t.isin === pageIsin)
        .map(({ instrumentName: _name, ...rest }) => rest);
      expect(fundRows.length).toBeGreaterThan(0);
      const committed = await answer(() =>
        service.commitDraftBody(userId, {
          accountId,
          filename: "liite.txt",
          sha256: body.sha256,
          kind: "paste",
          draft: { txns: fundRows, problems: [], unknownIsins: [] },
        }),
      );
      expect(committed.status).toBe(200);
      // SAFETY: the body has the shape the route returns.
      const result = committed.body as { importId: number; inserted: number };
      expect(result.inserted).toBe(fundRows.length);
      const fund = await db.select().from(instruments).where(eq(instruments.isin, pageIsin)).get();
      expect(fund).toBeDefined();
      const linked = await linkedRows(result.importId);
      expect(linked.every((r) => r.instrumentId === fund?.id)).toBe(true);
    } finally {
      service._setPageLookup(null);
      await db.delete(instrumentLookups).where(inArray(instrumentLookups.key, keys));
    }
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
    // SAFETY: the body has the shape the route returns.
    const body = previewed.body as {
      unknownIsins: unknown[];
      added: Array<{ isin: string; pending: boolean }>;
    };
    expect(body.unknownIsins).toEqual([]);
    expect(body.added).toMatchObject([{ isin, pending: true }]);

    const committed = await commitPreviewed(userId, previewed, accountId, "csv");
    expect(committed.status).toBe(200);
    // SAFETY: the body has the shape the route returns.
    const result = committed.body as { importId: number };
    const created = await db.select().from(instruments).where(eq(instruments.isin, isin)).get();
    expect(created).toMatchObject({
      priceSource: "manual",
      sourceKey: isin,
      lookupStatus: "pending",
    });
    expect(await linkedRows(result.importId)).toEqual([{ instrumentId: created?.id }]);
  });

  test("the model failing at preview leaves the import committable with the instrument pending", async () => {
    const { userId } = await signUp(`imp-auto-model-down-${crypto.randomUUID()}@example.com`);
    const accountId = await openAccount(userId);
    const isin = freshIsin();
    const down = (): Promise<never> => Promise.reject(new APIConnectionError({ message: "down" }));
    service._setPageLookup({ find: down, client: { run: down } });

    try {
      const previewed = await previewOne(userId, accountId, isin);
      // SAFETY: the body has the shape the route returns.
      const body = previewed.body as {
        unknownIsins: unknown[];
        added: Array<{ isin: string; pending: boolean }>;
      };
      expect(body.unknownIsins).toEqual([]);
      expect(body.added).toMatchObject([{ isin, pending: true }]);

      const committed = await commitPreviewed(userId, previewed, accountId, "csv");
      expect(committed.status).toBe(200);
      // SAFETY: the body has the shape the route returns.
      const result = committed.body as { importId: number };
      const created = await db.select().from(instruments).where(eq(instruments.isin, isin)).get();
      expect(created).toMatchObject({ priceSource: "manual", lookupStatus: "pending" });
      expect(await linkedRows(result.importId)).toEqual([{ instrumentId: created?.id }]);
    } finally {
      service._setPageLookup(null);
    }
  });
});

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
    // SAFETY: the body has the shape the route returns.
    const { importId } = commitResponse.body as { importId: number };

    const undoResponse = await answer(() => service.undo(stranger.userId, importId));
    expect(undoResponse.status).toBe(404);
  });

  test("rejects an import id that is not a positive integer", () => {
    expect(UndoInput.safeParse({ importId: "not-a-number" }).success).toBe(false);
  });
});

const opPasteText = (): Promise<string> =>
  readText(`${import.meta.dirname}/../import/fixtures/op-web-paste-sample.txt`);

const randomIsin = (country = "FI"): string =>
  `${country}${crypto.randomUUID().replace(/-/g, "").toUpperCase().slice(0, 9)}0`;

const registerByName = async (name: string): Promise<void> => {
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
    // SAFETY: the body has the shape the route returns.
    const body = response.body as { error: string };
    expect(body.error).toContain("transaction list");
  });

  test("previews the real OP paste fixture and reports both name-only unresolved instruments", async () => {
    const { userId } = await signUp(`imp-paste-preview-ok-${crypto.randomUUID()}@example.com`);
    const accountId = await openAccount(userId, "op");
    const text = await opPasteText();
    const response = await answer(() =>
      service.previewPaste(userId, { text, accountId: accountId }),
    );
    expect(response.status).toBe(200);
    // SAFETY: the body has the shape the route returns.
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
    // SAFETY: the body has the shape the route returns.
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

    const previewResponse = await answer(() =>
      service.previewPaste(userId, { text: text, accountId: accountId }),
    );
    // SAFETY: the body has the shape the route returns.
    const previewBody = previewResponse.body as { unknownIsins: unknown[] };
    expect(previewBody.unknownIsins).toEqual([]);

    const commitResponse = await commitPreviewed(userId, previewResponse, accountId, "paste");
    // SAFETY: the body has the shape the route returns.
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

describe("a broker PDF", () => {
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
    // SAFETY: the body has the shape the route returns.
    expect((previewed.body as { broker: string; txns: unknown[] }).broker).toBe("pdf");

    const committed = await commitPreviewed(userId, previewed, accountId, "pdf");
    expect(committed.status).toBe(200);
    // SAFETY: the body has the shape the route returns.
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
    // SAFETY: the body has the shape the route returns.
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
    // SAFETY: the body has the shape the route returns.
    const body = previewed.body as {
      filename: string;
      sha256: string;
      txns: DraftBody["txns"];
      problems: DraftBody["problems"];
      unknownIsins: DraftBody["unknownIsins"];
    };
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
    // SAFETY: the body has the shape the route returns.
    const ownerBody = ownerList.body as unknown[];
    // SAFETY: the body has the shape the route returns.
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
    // SAFETY: the body has the shape the route returns.
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
    // SAFETY: the body has the shape the route returns.
    const { importId: secondId } = secondCommit.body as { importId: number };

    const undoResponse = await answer(() => service.undo(userId, firstId));
    expect(undoResponse.status).toBe(200);

    const listResponse = await answer(() => service.listImports(userId));
    expect(listResponse.status).toBe(200);
    // SAFETY: the body has the shape the route returns.
    const list = listResponse.body as Array<{
      id: number;
      kind: string;
      filename: string;
      createdAt: string;
      inserted: number;
      skipped: number;
      undone: boolean;
    }>;
    expect(list[0]!.id).toBe(secondId);
    expect(list[1]!.id).toBe(firstId);

    const secondEntry = list.find((r) => r.id === secondId)!;
    expect(secondEntry.kind).toBe("csv");
    expect(secondEntry.filename).toBe("second.csv");
    expect(secondEntry.inserted).toBe(1);
    expect(secondEntry.skipped).toBe(0);
    expect(secondEntry.undone).toBe(false);
    expect(() => new Date(secondEntry.createdAt).toISOString()).not.toThrow();

    const firstEntry = list.find((r) => r.id === firstId)!;
    expect(firstEntry.filename).toBe("first.csv");
    expect(firstEntry.inserted).toBe(1);
    expect(firstEntry.undone).toBe(true);
  });
});

describe("preview suggestions for rows the recipe could not read", () => {
  const ASKED = "could not be read by the reading recipe";
  const suggesting = (text: string) => ({
    run: (params: { readonly messages: readonly { readonly content: string }[] }) =>
      params.messages[0]?.content.includes(ASKED)
        ? Promise.resolve({ text, toolCalls: [] })
        : nordnetReader.run(params),
  });
  const PreviewProblems = z.object({
    problems: z.array(
      z.object({ line: z.number(), suggestion: z.record(z.string(), z.string()).optional() }),
    ),
  });
  const goodRow = nordnetRow({
    id: "3000",
    date: "2025-02-01",
    type: "OSTO",
    name: "NOKIA",
    isin: "FI0009000681",
    qty: "10",
    price: "4,00",
    amount: "-40,00",
  });
  const badRow = nordnetRow({
    id: "3001",
    date: "2025-02-03",
    type: "TUNTEMATON",
    name: "NOKIA",
    isin: "FI0009000681",
    qty: "100",
    price: "4,15",
    amount: "-415,00",
  });

  afterEach(() => service._setReaderClient(nordnetReader));

  test("a problem row carries the checked suggestion; an invented amount is dropped", async () => {
    const { userId } = await signUp(`imp-suggest-${crypto.randomUUID()}@example.com`);
    const accountId = await openAccount(userId);
    service._setReaderClient(
      suggesting(
        JSON.stringify({
          rows: [
            {
              id: 0,
              fields: {
                tradeDate: "2025-02-03",
                type: "BUY",
                isin: "FI0009000681",
                quantityText: "100",
                amountEur: "777.77",
                feeEur: null,
                currency: null,
              },
            },
          ],
        }),
      ),
    );
    const previewed = await answer(() =>
      service.previewUpload(userId, uploadForm(nordnetFileOf([goodRow, badRow]), accountId)),
    );
    const body = PreviewProblems.parse(previewed.body);
    expect(body.problems).toHaveLength(1);
    expect(body.problems[0]?.suggestion).toEqual({
      tradeDate: "2025-02-03",
      isin: "FI0009000681",
      quantityText: "100",
    });
  });

  test("a failing model leaves the problem without a suggestion", async () => {
    const { userId } = await signUp(`imp-suggest-down-${crypto.randomUUID()}@example.com`);
    const accountId = await openAccount(userId);
    service._setReaderClient(suggesting("nope"));
    const previewed = await answer(() =>
      service.previewUpload(userId, uploadForm(nordnetFileOf([goodRow, badRow]), accountId)),
    );
    const body = PreviewProblems.parse(previewed.body);
    expect(body.problems).toHaveLength(1);
    expect(body.problems[0]?.suggestion).toBeUndefined();
  });
});

import { beforeAll, describe, expect, test } from "vitest";
import { CreateAccount, openAccount as openAccountRow } from "../accounts.ts";
import { getDb } from "../db/index.ts";
import { addInstrument } from "../instruments/store.ts";

import { EUR } from "../../core/money.ts";
import { HttpError } from "../errors.ts";
import { z, ZodError } from "zod";

// Snapshots are compared against the ledger, never merged into it, so these
// tests care about two things: that a statement round-trips intact, and that
// the reconciliation reports differences without touching any transaction.
// Mirrors portfolio.test.ts's setup, including its reliance on ../test-setup.ts
// (a vitest.config.ts `[test] preload`) having pinned the shared getDb() handle to a
// migrated in-memory database before this file's own code runs.

let auth: (typeof import("../auth.ts"))["auth"];
let service: typeof import("./service.ts");
let transactions: (typeof import("../db/schema.ts"))["transactions"];

beforeAll(async () => {
  auth = (await import("../auth.ts")).auth;
  service = await import("./service.ts");
  transactions = (await import("../db/schema.ts")).transactions;
});

const ProposalSchema = z.object({
  rows: z.array(z.object({ name: z.string() })),
  problems: z.array(z.object({ line: z.number() })),
});

/** What the caller sees: a value, or the status and message a refusal carries. */
type Refusal = { error: string };
type Answer<T> = { status: number; body: T | Refusal };

const answer = async <T>(run: () => T | Promise<T>): Promise<Answer<T>> => {
  try {
    return { status: 200, body: await run() };
  } catch (cause) {
    if (cause instanceof HttpError) return { status: cause.status, body: { error: cause.message } };
    if (cause instanceof ZodError) {
      return {
        status: 400,
        body: { error: cause.issues[0]?.message ?? "Virheellinen pyyntö" },
      };
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
      body: JSON.stringify({
        name: "Test User",
        email,
        password: "correct horse battery staple",
      }),
    }),
  );
  if (response.status !== 200) throw new Error(`sign-up failed with status ${response.status}`);
  // SAFETY: a 200 from POST /sign-up/email always carries `{ user: { id } }`.
  const body = (await response.json()) as { user: { id: string } };
  return { userId: body.user.id, cookie: sessionCookieFrom(response) };
};

const randomIsin = (): string =>
  `SE${crypto.randomUUID().replace(/-/g, "").toUpperCase().slice(0, 9)}0`;

const createAccount = (userId: string): number =>
  openAccountRow(getDb().db, userId, CreateAccount.parse({ name: "Nordnet", broker: "nordnet" }))
    .id;

const createInstrument = (): number => {
  const isin = randomIsin();
  const response = addInstrument(getDb().db, {
    isin,
    ticker: null,
    name: "Test Fund",
    kind: "fund",
    currency: EUR,
    priceSource: "manual",
  });
  return response.id;
};

const buy = (accountId: number, instrumentId: number, qty: string, date: string): void => {
  getDb()
    .db.insert(transactions)
    .values({
      accountId,
      instrumentId,
      type: "BUY",
      tradeDate: date,
      quantity: Number(qty),
      unitPrice: 1000,
      amount: -100000,
      fee: 0,
      tax: 0,
      currency: EUR,
      fxRateEur: 100_000_000,
      contentHash: crypto.randomUUID(),
    })
    .run();
};

/** The wire shape POST /api/snapshots accepts; the route parses it with zod itself. */
type SnapshotRequest = {
  accountId: number;
  asOf: string;
  source: "pdf" | "vision" | "manual";
  rows: Array<{
    instrumentId: number;
    quantity: string;
    nav?: string;
    marketValue?: string;
  }>;
};

const postSnapshot = (userId: string, body: SnapshotRequest) =>
  answer(() => service.createSnapshot(userId, body));

const reconcileOf = (userId: string, id: number) =>
  answer(() => service.reconcileSnapshot(userId, id));

describe("POST /api/snapshots", () => {
  test("refuses an account belonging to someone else, as 404 rather than 403", async () => {
    const owner = await signUp(`snap-owner-${crypto.randomUUID()}@example.com`);
    const accountId = createAccount(owner.userId);
    const instrumentId = createInstrument();
    const stranger = await signUp(`snap-stranger-${crypto.randomUUID()}@example.com`);

    const response = await postSnapshot(stranger.userId, {
      accountId,
      asOf: "2026-06-30",
      source: "manual",
      rows: [{ instrumentId, quantity: "1" }],
    });
    // 404, not 403: "not yours" must be indistinguishable from "does not exist".
    expect(response.status).toBe(404);
  });

  test("refuses a row naming an instrument that does not exist", async () => {
    const { userId } = await signUp(`snap-unknown-${crypto.randomUUID()}@example.com`);
    const accountId = createAccount(userId);
    const response = await postSnapshot(userId, {
      accountId,
      asOf: "2026-06-30",
      source: "manual",
      rows: [{ instrumentId: 999_999, quantity: "1" }],
    });
    // Dropping it silently would report a clean statement that never was.
    expect(response.status).toBe(400);
  });

  test("refuses a statement with no rows at all", async () => {
    const { userId } = await signUp(`snap-empty-${crypto.randomUUID()}@example.com`);
    const accountId = createAccount(userId);
    const response = await postSnapshot(userId, {
      accountId,
      asOf: "2026-06-30",
      source: "manual",
      rows: [],
    });
    expect(response.status).toBe(400);
  });

  test("stores a fractional quantity without losing precision", async () => {
    const { userId } = await signUp(`snap-frac-${crypto.randomUUID()}@example.com`);
    const accountId = createAccount(userId);
    const instrumentId = createInstrument();

    const created = await postSnapshot(userId, {
      accountId,
      asOf: "2026-06-30",
      source: "pdf",
      rows: [
        {
          instrumentId,
          quantity: "12.595200",
          nav: "170.64",
          marketValue: "2149.44",
        },
      ],
    });
    // SAFETY: a 201 from POST /api/snapshots returns the inserted row's id.
    const snapshot = created.body as { id: number };

    const response = await reconcileOf(userId, snapshot.id);
    expect(response.status).toBe(200);
    // SAFETY: a 200 from the reconcile route always returns this shape.
    const body = response.body as { rows: Array<{ snapshot: string }> };
    expect(body.rows[0]!.snapshot).toBe("12.595200");
  });
});

describe("GET /api/snapshots/:id/reconcile", () => {
  test("reports no differences when the ledger agrees with the statement", async () => {
    const { userId } = await signUp(`rec-agree-${crypto.randomUUID()}@example.com`);
    const accountId = createAccount(userId);
    const instrumentId = createInstrument();
    buy(accountId, instrumentId, "10000000", "2026-01-05"); // 10 units, scaled 1e6

    const created = await postSnapshot(userId, {
      accountId,
      asOf: "2026-06-30",
      source: "manual",
      rows: [{ instrumentId, quantity: "10" }],
    });
    // SAFETY: as above.
    // SAFETY: a 201 from POST /api/snapshots returns the inserted row's id.
    const snapshot = created.body as { id: number };

    const response = await reconcileOf(userId, snapshot.id);
    // SAFETY: as above.
    const body = response.body as {
      differences: number;
      rows: Array<{
        delta: string;
        withinTolerance: boolean;
        name: string | null;
      }>;
    };
    expect(body.differences).toBe(0);
    expect(body.rows[0]!.delta).toBe("0.000000");
    expect(body.rows[0]!.name).toBe("Test Fund");
  });

  test("reports the difference, and changes nothing in the ledger", async () => {
    const { userId } = await signUp(`rec-diff-${crypto.randomUUID()}@example.com`);
    const accountId = createAccount(userId);
    const instrumentId = createInstrument();
    buy(accountId, instrumentId, "10000000", "2026-01-05");

    const before = getDb().db.select().from(transactions).all().length;
    const created = await postSnapshot(userId, {
      accountId,
      asOf: "2026-06-30",
      source: "manual",
      rows: [{ instrumentId, quantity: "15" }],
    });
    // SAFETY: as above.
    // SAFETY: a 201 from POST /api/snapshots returns the inserted row's id.
    const snapshot = created.body as { id: number };

    const response = await reconcileOf(userId, snapshot.id);
    // SAFETY: as above.
    const body = response.body as {
      differences: number;
      rows: Array<{ delta: string }>;
    };
    expect(body.differences).toBe(1);
    expect(body.rows[0]!.delta).toBe("5.000000");
    // The whole point: reconciling reports, it never writes.
    expect(getDb().db.select().from(transactions).all().length).toBe(before);
  });

  test("compares only the statement's own account", async () => {
    const { userId, cookie } = await signUp(`rec-scope-${crypto.randomUUID()}@example.com`);
    const accountId = createAccount(userId);
    const otherAccountId = createAccount(userId);
    const instrumentId = createInstrument();
    const elsewhereId = createInstrument();
    buy(accountId, instrumentId, "10000000", "2026-01-05");
    buy(otherAccountId, elsewhereId, "7000000", "2026-01-05");

    const created = await postSnapshot(userId, {
      accountId,
      asOf: "2026-06-30",
      source: "manual",
      rows: [{ instrumentId, quantity: "10" }],
    });
    // SAFETY: as above.
    // SAFETY: a 201 from POST /api/snapshots returns the inserted row's id.
    const snapshot = created.body as { id: number };

    const response = await reconcileOf(userId, snapshot.id);
    // SAFETY: as above.
    const body = response.body as { rows: Array<{ instrumentId: number }> };
    // The other account's holding must not appear as a phantom difference.
    expect(body.rows.map((r) => r.instrumentId)).toEqual([instrumentId]);
  });

  test("refuses a snapshot belonging to someone else", async () => {
    const owner = await signUp(`rec-owner-${crypto.randomUUID()}@example.com`);
    const accountId = createAccount(owner.userId);
    const instrumentId = createInstrument();
    const created = await postSnapshot(owner.userId, {
      accountId,
      asOf: "2026-06-30",
      source: "manual",
      rows: [{ instrumentId, quantity: "1" }],
    });
    // SAFETY: as above.
    // SAFETY: a 201 from POST /api/snapshots returns the inserted row's id.
    const snapshot = created.body as { id: number };

    const stranger = await signUp(`rec-stranger-${crypto.randomUUID()}@example.com`);
    expect((await reconcileOf(stranger.userId, snapshot.id)).status).toBe(404);
  });

  test("404s for a snapshot that does not exist", async () => {
    const { userId, cookie } = await signUp(`rec-missing-${crypto.randomUUID()}@example.com`);
    expect((await reconcileOf(userId, 999_999)).status).toBe(404);
  });
});

describe("POST /api/snapshots/:id/adjust", () => {
  /** The wire shape POST /api/snapshots/:id/adjust accepts; the route parses it itself. */
  type AdjustRequest = { instrumentId: number; costEur?: string };

  const adjust = (userId: string, id: number, body: AdjustRequest) =>
    answer(() => service.adjustSnapshotRow(userId, id, body));

  const setup = async (statementQty: string, ledgerQty: string | null) => {
    const { userId, cookie } = await signUp(`adj-${crypto.randomUUID()}@example.com`);
    const accountId = createAccount(userId);
    const instrumentId = createInstrument();
    if (ledgerQty !== null) buy(accountId, instrumentId, ledgerQty, "2026-01-05");
    const created = await postSnapshot(userId, {
      accountId,
      asOf: "2026-06-30",
      source: "manual",
      rows: [{ instrumentId, quantity: statementQty }],
    });
    // SAFETY: a 201 always returns the inserted snapshot.
    // SAFETY: a 201 from POST /api/snapshots returns the inserted row's id.
    const snapshot = created.body as { id: number };
    return { userId, accountId, instrumentId, snapshotId: snapshot.id };
  };

  test("adding units requires a cost basis rather than inventing one", async () => {
    const { userId, instrumentId, snapshotId } = await setup("15", "10000000");
    const response = await adjust(userId, snapshotId, { instrumentId });
    // Defaulting it to zero would report the whole holding as gain later.
    expect(response.status).toBe(400);
  });

  test("adding units writes a marked, identifiable transaction", async () => {
    const { userId, instrumentId, snapshotId } = await setup("15", "10000000");
    const response = await adjust(userId, snapshotId, {
      instrumentId,
      costEur: "500.00",
    });
    // SAFETY: a successful adjustment returns the transaction it wrote.
    const txn = response.body as {
      type: string;
      quantity: number;
      amount: number;
      externalId: string;
      note: string;
    };
    expect(txn.type).toBe("TRANSFER_IN");
    expect(txn.quantity).toBe(5_000_000);
    // Negative: an acquisition's amount is the cash that left.
    expect(txn.amount).toBe(-50000);
    expect(txn.externalId).toBe(`adjustment:${snapshotId}:${instrumentId}`);
    expect(txn.note).toContain("Täsmäytyskorjaus");
  });

  test("removing units takes no cost basis", async () => {
    const { userId, instrumentId, snapshotId } = await setup("4", "10000000");
    expect((await adjust(userId, snapshotId, { instrumentId, costEur: "10" })).status).toBe(400);

    const response = await adjust(userId, snapshotId, { instrumentId });
    // SAFETY: as above -- an adjustment answers with the row it wrote.
    const txn = response.body as { type: string; quantity: number };
    expect(txn.type).toBe("TRANSFER_OUT");
    expect(txn.quantity).toBe(6_000_000);
  });

  test("the same row cannot be adjusted twice", async () => {
    const { userId, instrumentId, snapshotId } = await setup("15", "10000000");
    expect((await adjust(userId, snapshotId, { instrumentId, costEur: "500" })).status).toBe(200);
    // Idempotency comes from the unique (accountId, externalId) index, so a
    // second attempt is a conflict rather than a silent duplicate holding.
    expect((await adjust(userId, snapshotId, { instrumentId, costEur: "500" })).status).toBe(409);
  });

  test("a row that already matches has nothing to adjust", async () => {
    const { userId, instrumentId, snapshotId } = await setup("10", "10000000");
    expect((await adjust(userId, snapshotId, { instrumentId })).status).toBe(400);
  });

  test("adjusting reconciles the row it fixed", async () => {
    const { userId, instrumentId, snapshotId } = await setup("15", "10000000");
    await adjust(userId, snapshotId, { instrumentId, costEur: "500" });

    const response = await reconcileOf(userId, snapshotId);
    // SAFETY: as above.
    const body = response.body as { differences: number };
    expect(body.differences).toBe(0);
  });

  test("refuses a snapshot belonging to someone else", async () => {
    const { instrumentId, snapshotId } = await setup("15", "10000000");
    const stranger = await signUp(`adj-stranger-${crypto.randomUUID()}@example.com`);
    expect(
      (
        await adjust(stranger.userId, snapshotId, {
          instrumentId,
          costEur: "500",
        })
      ).status,
    ).toBe(404);
  });
});

describe("DELETE /api/snapshots/:id", () => {
  const remove = (userId: string, id: number) => answer(() => service.deleteSnapshot(userId, id));

  test("removes the statement and its rows", async () => {
    const { userId, cookie } = await signUp(`del-${crypto.randomUUID()}@example.com`);
    const accountId = createAccount(userId);
    const instrumentId = createInstrument();
    const created = await postSnapshot(userId, {
      accountId,
      asOf: "2026-06-30",
      source: "manual",
      rows: [{ instrumentId, quantity: "10" }],
    });
    // SAFETY: a 201 always returns the inserted snapshot.
    // SAFETY: a 201 from POST /api/snapshots returns the inserted row's id.
    const snapshot = created.body as { id: number };

    expect((await remove(userId, snapshot.id)).status).toBe(200);
    expect((await reconcileOf(userId, snapshot.id)).status).toBe(404);
  });

  test("an adjustment the statement produced survives its deletion", async () => {
    const { userId, cookie } = await signUp(`del-adj-${crypto.randomUUID()}@example.com`);
    const accountId = createAccount(userId);
    const instrumentId = createInstrument();
    buy(accountId, instrumentId, "10000000", "2026-01-05");
    const created = await postSnapshot(userId, {
      accountId,
      asOf: "2026-06-30",
      source: "manual",
      rows: [{ instrumentId, quantity: "15" }],
    });
    // SAFETY: as above.
    // SAFETY: a 201 from POST /api/snapshots returns the inserted row's id.
    const snapshot = created.body as { id: number };
    await answer(() =>
      service.adjustSnapshotRow(userId, snapshot.id, {
        instrumentId,
        costEur: "500",
      }),
    );

    const before = getDb().db.select().from(transactions).all().length;
    expect((await remove(userId, snapshot.id)).status).toBe(200);
    // Tidying up a statement must never retract a ledger entry the user chose
    // to make -- that would change holdings as a side effect.
    expect(getDb().db.select().from(transactions).all().length).toBe(before);
  });

  test("refuses a statement belonging to someone else", async () => {
    const owner = await signUp(`del-owner-${crypto.randomUUID()}@example.com`);
    const accountId = createAccount(owner.userId);
    const instrumentId = createInstrument();
    const created = await postSnapshot(owner.userId, {
      accountId,
      asOf: "2026-06-30",
      source: "manual",
      rows: [{ instrumentId, quantity: "1" }],
    });
    // SAFETY: as above.
    // SAFETY: a 201 from POST /api/snapshots returns the inserted row's id.
    const snapshot = created.body as { id: number };

    const stranger = await signUp(`del-stranger-${crypto.randomUUID()}@example.com`);
    expect((await remove(stranger.userId, snapshot.id)).status).toBe(404);
    // And it is still there afterwards.
    expect((await reconcileOf(owner.userId, snapshot.id)).status).toBe(200);
  });
});

describe("POST /api/snapshots/paste", () => {
  const HEADER = "Nimi\tValuutta\tMäärä\tArvo EUR";
  const paste = (userId: string, body: { asOf: string; text: string }) =>
    answer(() => service.proposeFromPaste(userId, body));

  test("proposes the pasted rows without storing anything", async () => {
    const { userId } = await signUp(`paste-${crypto.randomUUID()}@example.com`);
    const before = getDb().db.select().from(transactions).all().length;

    const response = await paste(userId, {
      asOf: "2026-06-30",
      text: [HEADER, "Esimerkki Indeksi\tEUR\t27,4431\t10072,715424"].join("\n"),
    });
    expect(response.status).toBe(200);
    // SAFETY: a 200 from this route always returns { asOf, rows, problems }.
    const body = response.body as {
      rows: Array<{ name: string; quantity: string; marketValueEur: string }>;
    };
    expect(body.rows[0]!.quantity).toBe("27.4431");
    expect(body.rows[0]!.marketValueEur).toBe("10072.72");
    expect(getDb().db.select().from(transactions).all().length).toBe(before);
  });

  test("suggests an instrument matching by name", async () => {
    const { userId } = await signUp(`paste-match-${crypto.randomUUID()}@example.com`);
    const created = addInstrument(getDb().db, {
      isin: randomIsin(),
      ticker: null,
      name: "Paste Match Fund",
      kind: "fund",
      currency: EUR,
      priceSource: "manual",
    });
    const instrument = created;

    const response = await paste(userId, {
      asOf: "2026-06-30",
      text: [HEADER, "Paste Match Fund\tEUR\t10\t100,00"].join("\n"),
    });
    // SAFETY: as above.
    const body = response.body as {
      rows: Array<{ instrumentId: number | null }>;
    };
    expect(body.rows[0]!.instrumentId).toBe(instrument.id);
  });

  test("reports an unreadable row without losing the readable ones", async () => {
    const { userId } = await signUp(`paste-bad-${crypto.randomUUID()}@example.com`);
    const response = await paste(userId, {
      asOf: "2026-06-30",
      text: [HEADER, "Hyvä\tEUR\t10\t100,00", "Huono\tEUR\tei-luku\t50,00"].join("\n"),
    });
    const body = ProposalSchema.parse(response.body);
    expect(body.rows.map((r) => r.name)).toEqual(["Hyvä"]);
    expect(body.problems).toHaveLength(1);
  });

  test("refuses a paste whose header is missing a needed column", async () => {
    const { userId } = await signUp(`paste-hdr-${crypto.randomUUID()}@example.com`);
    const response = await paste(userId, {
      asOf: "2026-06-30",
      text: ["Nimi\tArvo EUR", "Esimerkki\t10,00"].join("\n"),
    });
    expect(response.status).toBe(400);
  });
});

describe("POST /api/snapshots/csv", () => {
  /** UTF-16LE with a byte-order mark, the way Nordnet writes its exports. */
  const utf16le = (text: string): ArrayBuffer => {
    const withBom = `﻿${text}`;
    const bytes = new Uint8Array(withBom.length * 2);
    for (let i = 0; i < withBom.length; i++) {
      const code = withBom.charCodeAt(i);
      bytes[i * 2] = code & 0xff;
      bytes[i * 2 + 1] = code >> 8;
    }
    // SAFETY: a freshly allocated Uint8Array always owns a plain ArrayBuffer.
    return bytes.buffer as ArrayBuffer;
  };

  const upload = (userId: string, body: ArrayBuffer, asOf = "2026-06-30") => {
    const form = new FormData();
    form.set("file", new File([body], "omistukset.csv", { type: "text/csv" }));
    form.set("asOf", asOf);
    return answer(() => service.proposeFromCsv(userId, form));
  };

  const CSV = [
    "Nimi\tValuutta\tMäärä\tArvo EUR",
    "Esimerkki Indeksi\tEUR\t27,4431\t10072,715424",
  ].join("\n");

  // Nordnet writes UTF-16LE; read as UTF-8 the file is a run of null bytes.
  test("reads a UTF-16 export and proposes its rows", async () => {
    const { userId } = await signUp(`csv-${crypto.randomUUID()}@example.com`);
    const before = getDb().db.select().from(transactions).all().length;

    const response = await upload(userId, utf16le(CSV));
    expect(response.status).toBe(200);
    // SAFETY: a 200 from this route always returns { asOf, rows, problems }.
    const body = response.body as {
      asOf: string;
      rows: Array<{ name: string; quantity: string; marketValueEur: string }>;
    };
    expect(body.asOf).toBe("2026-06-30");
    expect(body.rows[0]!.quantity).toBe("27.4431");
    expect(body.rows[0]!.marketValueEur).toBe("10072.72");
    // A preview stores nothing.
    expect(getDb().db.select().from(transactions).all().length).toBe(before);
  });

  test("reads a plain UTF-8 export too, since not every broker writes UTF-16", async () => {
    const { userId } = await signUp(`csv-utf8-${crypto.randomUUID()}@example.com`);
    const bytes = new TextEncoder().encode(CSV);
    // SAFETY: TextEncoder always allocates a plain ArrayBuffer, never a shared one.
    const response = await upload(userId, bytes.buffer as ArrayBuffer);
    expect(response.status).toBe(200);
  });

  test("refuses a file whose header lacks a needed column", async () => {
    const { userId } = await signUp(`csv-bad-${crypto.randomUUID()}@example.com`);
    const response = await upload(userId, utf16le("Nimi\tArvo EUR\nEsimerkki\t10,00"));
    expect(response.status).toBe(400);
  });
});

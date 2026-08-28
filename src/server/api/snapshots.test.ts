import { beforeAll, describe, expect, test } from "bun:test";

import { EUR } from "../../core/money";

// Snapshots are compared against the ledger, never merged into it, so these
// tests care about two things: that a statement round-trips intact, and that
// the reconciliation reports differences without touching any transaction.
// Mirrors portfolio.test.ts's setup, including its reliance on ../test-setup.ts
// (a bunfig.toml `[test] preload`) having pinned the shared getDb() handle to a
// migrated in-memory database before this file's own code runs.

let auth: (typeof import("../auth"))["auth"];
let accountRoutes: (typeof import("./accounts"))["accountRoutes"];
let instrumentRoutes: (typeof import("./instruments"))["instrumentRoutes"];
let snapshotRoutes: (typeof import("./snapshots"))["snapshotRoutes"];
let db: ReturnType<(typeof import("../db"))["getDb"]>["db"];
let transactions: (typeof import("../db/schema"))["transactions"];

beforeAll(async () => {
  auth = (await import("../auth")).auth;
  accountRoutes = (await import("./accounts")).accountRoutes;
  instrumentRoutes = (await import("./instruments")).instrumentRoutes;
  snapshotRoutes = (await import("./snapshots")).snapshotRoutes;
  db = (await import("../db")).getDb().db;
  transactions = (await import("../db/schema")).transactions;
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
  // SAFETY: a 200 from POST /sign-up/email always carries `{ user: { id } }`.
  const body = (await response.json()) as { user: { id: string } };
  return { userId: body.user.id, cookie: sessionCookieFrom(response) };
};

const randomIsin = (): string =>
  `SE${crypto.randomUUID().replace(/-/g, "").toUpperCase().slice(0, 9)}0`;

const createAccount = async (cookie: string): Promise<number> => {
  const response = await accountRoutes["/api/accounts"].POST(
    new Request("http://x/api/accounts", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "Nordnet", broker: "nordnet" }),
    }),
  );
  expect(response.status).toBe(201);
  // SAFETY: a 201 from POST /api/accounts always returns the inserted row.
  return ((await response.json()) as { id: number }).id;
};

const createInstrument = async (cookie: string): Promise<number> => {
  const isin = randomIsin();
  const response = await instrumentRoutes["/api/instruments"].POST(
    new Request("http://x/api/instruments", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        isin,
        ticker: null,
        name: "Test Fund",
        kind: "fund",
        currency: "EUR",
        priceSource: "manual",
      }),
    }),
  );
  expect(response.status).toBe(201);
  // SAFETY: as above.
  return ((await response.json()) as { id: number }).id;
};

const buy = (accountId: number, instrumentId: number, qty: string, date: string): void => {
  db.insert(transactions)
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
  rows: Array<{ instrumentId: number; quantity: string; nav?: string; marketValue?: string }>;
};

const postSnapshot = async (cookie: string, body: SnapshotRequest): Promise<Response> =>
  snapshotRoutes["/api/snapshots"].POST(
    new Request("http://x/api/snapshots", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(body),
    }),
  );

const reconcileOf = async (cookie: string, id: number): Promise<Response> =>
  snapshotRoutes["/api/snapshots/:id/reconcile"].GET(
    new Request(`http://x/api/snapshots/${id}/reconcile`, { headers: { cookie } }),
  );

describe("POST /api/snapshots", () => {
  test("rejects a request with no session", async () => {
    const response = await postSnapshot("", {
      accountId: 1,
      asOf: "2026-06-30",
      source: "manual",
      rows: [],
    });
    expect(response.status).toBe(401);
  });

  test("refuses an account belonging to someone else, as 404 rather than 403", async () => {
    const owner = await signUp(`snap-owner-${crypto.randomUUID()}@example.com`);
    const accountId = await createAccount(owner.cookie);
    const instrumentId = await createInstrument(owner.cookie);
    const stranger = await signUp(`snap-stranger-${crypto.randomUUID()}@example.com`);

    const response = await postSnapshot(stranger.cookie, {
      accountId,
      asOf: "2026-06-30",
      source: "manual",
      rows: [{ instrumentId, quantity: "1" }],
    });
    // 404, not 403: "not yours" must be indistinguishable from "does not exist".
    expect(response.status).toBe(404);
  });

  test("refuses a row naming an instrument that does not exist", async () => {
    const { cookie } = await signUp(`snap-unknown-${crypto.randomUUID()}@example.com`);
    const accountId = await createAccount(cookie);
    const response = await postSnapshot(cookie, {
      accountId,
      asOf: "2026-06-30",
      source: "manual",
      rows: [{ instrumentId: 999_999, quantity: "1" }],
    });
    // Dropping it silently would report a clean statement that never was.
    expect(response.status).toBe(400);
  });

  test("refuses a statement with no rows at all", async () => {
    const { cookie } = await signUp(`snap-empty-${crypto.randomUUID()}@example.com`);
    const accountId = await createAccount(cookie);
    const response = await postSnapshot(cookie, {
      accountId,
      asOf: "2026-06-30",
      source: "manual",
      rows: [],
    });
    expect(response.status).toBe(400);
  });

  test("stores a fractional quantity without losing precision", async () => {
    const { cookie } = await signUp(`snap-frac-${crypto.randomUUID()}@example.com`);
    const accountId = await createAccount(cookie);
    const instrumentId = await createInstrument(cookie);

    const created = await postSnapshot(cookie, {
      accountId,
      asOf: "2026-06-30",
      source: "pdf",
      rows: [{ instrumentId, quantity: "12.595200", nav: "170.64", marketValue: "2149.44" }],
    });
    expect(created.status).toBe(201);
    // SAFETY: a 201 always returns the inserted snapshot row.
    const snapshot = (await created.json()) as { id: number };

    const response = await reconcileOf(cookie, snapshot.id);
    expect(response.status).toBe(200);
    // SAFETY: a 200 from the reconcile route always returns this shape.
    const body = (await response.json()) as { rows: Array<{ snapshot: string }> };
    expect(body.rows[0]!.snapshot).toBe("12.595200");
  });
});

describe("GET /api/snapshots/:id/reconcile", () => {
  test("reports no differences when the ledger agrees with the statement", async () => {
    const { cookie } = await signUp(`rec-agree-${crypto.randomUUID()}@example.com`);
    const accountId = await createAccount(cookie);
    const instrumentId = await createInstrument(cookie);
    buy(accountId, instrumentId, "10000000", "2026-01-05"); // 10 units, scaled 1e6

    const created = await postSnapshot(cookie, {
      accountId,
      asOf: "2026-06-30",
      source: "manual",
      rows: [{ instrumentId, quantity: "10" }],
    });
    // SAFETY: as above.
    const snapshot = (await created.json()) as { id: number };

    const response = await reconcileOf(cookie, snapshot.id);
    // SAFETY: as above.
    const body = (await response.json()) as {
      differences: number;
      rows: Array<{ delta: string; withinTolerance: boolean; name: string | null }>;
    };
    expect(body.differences).toBe(0);
    expect(body.rows[0]!.delta).toBe("0.000000");
    expect(body.rows[0]!.name).toBe("Test Fund");
  });

  test("reports the difference, and changes nothing in the ledger", async () => {
    const { cookie } = await signUp(`rec-diff-${crypto.randomUUID()}@example.com`);
    const accountId = await createAccount(cookie);
    const instrumentId = await createInstrument(cookie);
    buy(accountId, instrumentId, "10000000", "2026-01-05");

    const before = db.select().from(transactions).all().length;
    const created = await postSnapshot(cookie, {
      accountId,
      asOf: "2026-06-30",
      source: "manual",
      rows: [{ instrumentId, quantity: "15" }],
    });
    // SAFETY: as above.
    const snapshot = (await created.json()) as { id: number };

    const response = await reconcileOf(cookie, snapshot.id);
    // SAFETY: as above.
    const body = (await response.json()) as { differences: number; rows: Array<{ delta: string }> };
    expect(body.differences).toBe(1);
    expect(body.rows[0]!.delta).toBe("5.000000");
    // The whole point: reconciling reports, it never writes.
    expect(db.select().from(transactions).all().length).toBe(before);
  });

  test("compares only the statement's own account", async () => {
    const { cookie } = await signUp(`rec-scope-${crypto.randomUUID()}@example.com`);
    const accountId = await createAccount(cookie);
    const otherAccountId = await createAccount(cookie);
    const instrumentId = await createInstrument(cookie);
    const elsewhereId = await createInstrument(cookie);
    buy(accountId, instrumentId, "10000000", "2026-01-05");
    buy(otherAccountId, elsewhereId, "7000000", "2026-01-05");

    const created = await postSnapshot(cookie, {
      accountId,
      asOf: "2026-06-30",
      source: "manual",
      rows: [{ instrumentId, quantity: "10" }],
    });
    // SAFETY: as above.
    const snapshot = (await created.json()) as { id: number };

    const response = await reconcileOf(cookie, snapshot.id);
    // SAFETY: as above.
    const body = (await response.json()) as { rows: Array<{ instrumentId: number }> };
    // The other account's holding must not appear as a phantom difference.
    expect(body.rows.map((r) => r.instrumentId)).toEqual([instrumentId]);
  });

  test("refuses a snapshot belonging to someone else", async () => {
    const owner = await signUp(`rec-owner-${crypto.randomUUID()}@example.com`);
    const accountId = await createAccount(owner.cookie);
    const instrumentId = await createInstrument(owner.cookie);
    const created = await postSnapshot(owner.cookie, {
      accountId,
      asOf: "2026-06-30",
      source: "manual",
      rows: [{ instrumentId, quantity: "1" }],
    });
    // SAFETY: as above.
    const snapshot = (await created.json()) as { id: number };

    const stranger = await signUp(`rec-stranger-${crypto.randomUUID()}@example.com`);
    expect((await reconcileOf(stranger.cookie, snapshot.id)).status).toBe(404);
  });

  test("404s for a snapshot that does not exist", async () => {
    const { cookie } = await signUp(`rec-missing-${crypto.randomUUID()}@example.com`);
    expect((await reconcileOf(cookie, 999_999)).status).toBe(404);
  });
});

describe("POST /api/snapshots/:id/adjust", () => {
  /** The wire shape POST /api/snapshots/:id/adjust accepts; the route parses it itself. */
  type AdjustRequest = { instrumentId: number; costEur?: string };

  const adjust = async (cookie: string, id: number, body: AdjustRequest): Promise<Response> =>
    snapshotRoutes["/api/snapshots/:id/adjust"].POST(
      new Request(`http://x/api/snapshots/${id}/adjust`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify(body),
      }),
    );

  const setup = async (statementQty: string, ledgerQty: string | null) => {
    const { cookie } = await signUp(`adj-${crypto.randomUUID()}@example.com`);
    const accountId = await createAccount(cookie);
    const instrumentId = await createInstrument(cookie);
    if (ledgerQty !== null) buy(accountId, instrumentId, ledgerQty, "2026-01-05");
    const created = await postSnapshot(cookie, {
      accountId,
      asOf: "2026-06-30",
      source: "manual",
      rows: [{ instrumentId, quantity: statementQty }],
    });
    // SAFETY: a 201 always returns the inserted snapshot.
    const snapshot = (await created.json()) as { id: number };
    return { cookie, accountId, instrumentId, snapshotId: snapshot.id };
  };

  test("adding units requires a cost basis rather than inventing one", async () => {
    const { cookie, instrumentId, snapshotId } = await setup("15", "10000000");
    const response = await adjust(cookie, snapshotId, { instrumentId });
    // Defaulting it to zero would report the whole holding as gain later.
    expect(response.status).toBe(400);
  });

  test("adding units writes a marked, identifiable transaction", async () => {
    const { cookie, instrumentId, snapshotId } = await setup("15", "10000000");
    const response = await adjust(cookie, snapshotId, { instrumentId, costEur: "500.00" });
    expect(response.status).toBe(201);
    // SAFETY: a 201 returns the inserted transaction row.
    const txn = (await response.json()) as {
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
    const { cookie, instrumentId, snapshotId } = await setup("4", "10000000");
    expect((await adjust(cookie, snapshotId, { instrumentId, costEur: "10" })).status).toBe(400);

    const response = await adjust(cookie, snapshotId, { instrumentId });
    expect(response.status).toBe(201);
    // SAFETY: as above.
    const txn = (await response.json()) as { type: string; quantity: number };
    expect(txn.type).toBe("TRANSFER_OUT");
    expect(txn.quantity).toBe(6_000_000);
  });

  test("the same row cannot be adjusted twice", async () => {
    const { cookie, instrumentId, snapshotId } = await setup("15", "10000000");
    expect((await adjust(cookie, snapshotId, { instrumentId, costEur: "500" })).status).toBe(201);
    // Idempotency comes from the unique (accountId, externalId) index, so a
    // second attempt is a conflict rather than a silent duplicate holding.
    expect((await adjust(cookie, snapshotId, { instrumentId, costEur: "500" })).status).toBe(409);
  });

  test("a row that already matches has nothing to adjust", async () => {
    const { cookie, instrumentId, snapshotId } = await setup("10", "10000000");
    expect((await adjust(cookie, snapshotId, { instrumentId })).status).toBe(400);
  });

  test("adjusting reconciles the row it fixed", async () => {
    const { cookie, instrumentId, snapshotId } = await setup("15", "10000000");
    await adjust(cookie, snapshotId, { instrumentId, costEur: "500" });

    const response = await reconcileOf(cookie, snapshotId);
    // SAFETY: as above.
    const body = (await response.json()) as { differences: number };
    expect(body.differences).toBe(0);
  });

  test("refuses a snapshot belonging to someone else", async () => {
    const { instrumentId, snapshotId } = await setup("15", "10000000");
    const stranger = await signUp(`adj-stranger-${crypto.randomUUID()}@example.com`);
    expect(
      (await adjust(stranger.cookie, snapshotId, { instrumentId, costEur: "500" })).status,
    ).toBe(404);
  });
});

describe("POST /api/snapshots/pdf", () => {
  const upload = async (cookie: string, bytes: ArrayBuffer): Promise<Response> => {
    const form = new FormData();
    form.set("file", new File([bytes], "ote.pdf", { type: "application/pdf" }));
    return snapshotRoutes["/api/snapshots/pdf"].POST(
      new Request("http://x/api/snapshots/pdf", {
        method: "POST",
        headers: { cookie },
        body: form,
      }),
    );
  };

  const fixture = (): Promise<ArrayBuffer> =>
    Bun.file(new URL("../import/fixtures/op-holdings-sample.pdf", import.meta.url)).arrayBuffer();

  test("rejects a request with no session", async () => {
    expect((await upload("", await fixture())).status).toBe(401);
  });

  test("proposes the statement's rows without storing anything", async () => {
    const { cookie } = await signUp(`pdf-${crypto.randomUUID()}@example.com`);
    const before = db.select().from(transactions).all().length;

    const response = await upload(cookie, await fixture());
    expect(response.status).toBe(200);
    // SAFETY: a 200 from this route always returns { asOf, rows }.
    const body = (await response.json()) as {
      asOf: string;
      rows: Array<{ name: string; quantity: string; instrumentId: number | null }>;
    };
    expect(body.asOf).toBe("2025-12-31");
    expect(body.rows).toHaveLength(2);
    expect(body.rows[0]!.quantity).toBe("15.4552");
    // A preview writes nothing at all.
    expect(db.select().from(transactions).all().length).toBe(before);
  });

  test("suggests an instrument whose name differs only by the broker's own suffix", async () => {
    const { cookie } = await signUp(`pdf-match-${crypto.randomUUID()}@example.com`);
    // Registered the way the ledger names it, not the way the statement prints it.
    const response = await instrumentRoutes["/api/instruments"].POST(
      new Request("http://x/api/instruments", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
          isin: randomIsin(),
          ticker: null,
          name: "ESIMERKKI-MAAILMA INDEKSI A",
          kind: "fund",
          currency: "EUR",
          priceSource: "manual",
        }),
      }),
    );
    // SAFETY: a 201 returns the inserted instrument.
    const instrument = (await response.json()) as { id: number };

    const preview = await upload(cookie, await fixture());
    // SAFETY: as above.
    const body = (await preview.json()) as {
      rows: Array<{ name: string; instrumentId: number | null }>;
    };
    const matched = body.rows.find((row) => row.name.includes("MAAILMA"));
    expect(matched?.instrumentId).toBe(instrument.id);
  });

  // Instruments are shared reference data across the whole process (see
  // instruments.ts), so this cannot assert "nothing matched" -- another test's
  // registration would make it flaky. It asserts the property that actually
  // matters instead: a suggestion is only ever an exact match once the broker's
  // own suffixes are removed, never the closest-looking name.
  test("only ever suggests an exact match, never the closest guess", async () => {
    const { cookie } = await signUp(`pdf-nomatch-${crypto.randomUUID()}@example.com`);
    const response = await instrumentRoutes["/api/instruments"].POST(
      new Request("http://x/api/instruments", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
          isin: randomIsin(),
          ticker: null,
          // Shares three words with the statement's AASIA fund and is a
          // different holding; it must not be suggested for it.
          name: "ESIMERKKI-AASIA OSAKE B",
          kind: "fund",
          currency: "EUR",
          priceSource: "manual",
        }),
      }),
    );
    // SAFETY: a 201 returns the inserted instrument.
    const decoy = (await response.json()) as { id: number };

    const preview = await upload(cookie, await fixture());
    // SAFETY: as above.
    const body = (await preview.json()) as {
      rows: Array<{ name: string; instrumentId: number | null }>;
    };
    const aasia = body.rows.find((row) => row.name.includes("AASIA"));
    expect(aasia?.instrumentId).not.toBe(decoy.id);
  });

  test("refuses a file with no readable statement in it", async () => {
    const { cookie } = await signUp(`pdf-bad-${crypto.randomUUID()}@example.com`);
    const bad = new TextEncoder().encode("%PDF-1.4\nnothing\n%%EOF\n");
    // SAFETY: TextEncoder always allocates a plain ArrayBuffer, never a shared
    // one, so this narrowing holds for every value this line can produce.
    const response = await upload(cookie, bad.buffer as ArrayBuffer);
    // The wrong file, or a scanned one with no text layer, is the caller's
    // problem -- and the vision path exists for the latter.
    expect(response.status).toBe(400);
  });
});

describe("DELETE /api/snapshots/:id", () => {
  const remove = async (cookie: string, id: number): Promise<Response> =>
    snapshotRoutes["/api/snapshots/:id"].DELETE(
      new Request(`http://x/api/snapshots/${id}`, { method: "DELETE", headers: { cookie } }),
    );

  test("removes the statement and its rows", async () => {
    const { cookie } = await signUp(`del-${crypto.randomUUID()}@example.com`);
    const accountId = await createAccount(cookie);
    const instrumentId = await createInstrument(cookie);
    const created = await postSnapshot(cookie, {
      accountId,
      asOf: "2026-06-30",
      source: "manual",
      rows: [{ instrumentId, quantity: "10" }],
    });
    // SAFETY: a 201 always returns the inserted snapshot.
    const snapshot = (await created.json()) as { id: number };

    expect((await remove(cookie, snapshot.id)).status).toBe(200);
    expect((await reconcileOf(cookie, snapshot.id)).status).toBe(404);
  });

  test("an adjustment the statement produced survives its deletion", async () => {
    const { cookie } = await signUp(`del-adj-${crypto.randomUUID()}@example.com`);
    const accountId = await createAccount(cookie);
    const instrumentId = await createInstrument(cookie);
    buy(accountId, instrumentId, "10000000", "2026-01-05");
    const created = await postSnapshot(cookie, {
      accountId,
      asOf: "2026-06-30",
      source: "manual",
      rows: [{ instrumentId, quantity: "15" }],
    });
    // SAFETY: as above.
    const snapshot = (await created.json()) as { id: number };
    await snapshotRoutes["/api/snapshots/:id/adjust"].POST(
      new Request(`http://x/api/snapshots/${snapshot.id}/adjust`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ instrumentId, costEur: "500" }),
      }),
    );

    const before = db.select().from(transactions).all().length;
    expect((await remove(cookie, snapshot.id)).status).toBe(200);
    // Tidying up a statement must never retract a ledger entry the user chose
    // to make -- that would change holdings as a side effect.
    expect(db.select().from(transactions).all().length).toBe(before);
  });

  test("refuses a statement belonging to someone else", async () => {
    const owner = await signUp(`del-owner-${crypto.randomUUID()}@example.com`);
    const accountId = await createAccount(owner.cookie);
    const instrumentId = await createInstrument(owner.cookie);
    const created = await postSnapshot(owner.cookie, {
      accountId,
      asOf: "2026-06-30",
      source: "manual",
      rows: [{ instrumentId, quantity: "1" }],
    });
    // SAFETY: as above.
    const snapshot = (await created.json()) as { id: number };

    const stranger = await signUp(`del-stranger-${crypto.randomUUID()}@example.com`);
    expect((await remove(stranger.cookie, snapshot.id)).status).toBe(404);
    // And it is still there afterwards.
    expect((await reconcileOf(owner.cookie, snapshot.id)).status).toBe(200);
  });
});

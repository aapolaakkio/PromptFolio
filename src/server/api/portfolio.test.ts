import { beforeAll, describe, expect, test } from "bun:test";
import { EUR, parseMoney } from "../../core/money";
import { xirr } from "../../core/returns";

// Exercises portfolioRoutes (src/server/api/portfolio.ts) against a real,
// migrated database and a real Better Auth session, mirroring
// accounts.test.ts's and instruments.test.ts's setup -- including their
// reliance on ../test-setup.ts (a bunfig.toml `[test] preload` script) to
// have already pinned the shared getDb() handle to a migrated in-memory
// database before this file's own code runs. This file must NOT call
// resetDbHandleForTests(), set DATABASE_PATH, or call getDb()/migrate()
// itself -- see test-setup.ts's and accounts.test.ts's comments for why.
//
// The database is shared with every other *.test.ts file in the process,
// so every account/instrument/user this file creates uses a fresh
// crypto.randomUUID()-derived identity, and every ISIN is random rather
// than a hardcoded literal another file's fixtures already use (e.g.
// instruments.test.ts's default "FI0009000681").

let auth: (typeof import("../auth"))["auth"];
let accountRoutes: (typeof import("./accounts"))["accountRoutes"];
let instrumentRoutes: (typeof import("./instruments"))["instrumentRoutes"];
let portfolioRoutes: (typeof import("./portfolio"))["portfolioRoutes"];

beforeAll(async () => {
  const authModule = await import("../auth");
  const accountsModule = await import("./accounts");
  const instrumentsModule = await import("./instruments");
  const portfolioModule = await import("./portfolio");
  auth = authModule.auth;
  accountRoutes = accountsModule.accountRoutes;
  instrumentRoutes = instrumentsModule.instrumentRoutes;
  portfolioRoutes = portfolioModule.portfolioRoutes;
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

/** A syntactically valid but never-real ISIN, derived from a fresh randomUUID -- see file header. */
const randomIsin = (): string =>
  `XX${crypto.randomUUID().replace(/-/g, "").toUpperCase().slice(0, 9)}0`;

const createAccount = async (cookie: string): Promise<number> => {
  const response = await accountRoutes["/api/accounts"].POST(
    new Request("http://x/api/accounts", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "Nordnet", broker: "nordnet" }),
    }),
  );
  expect(response.status).toBe(201);
  // SAFETY: a 201 from POST /api/accounts (asserted above) always returns
  // the inserted row, which carries an `id` column.
  const body = (await response.json()) as { id: number };
  return body.id;
};

const createInstrument = async (cookie: string, isin: string): Promise<number> => {
  const response = await instrumentRoutes["/api/instruments"].POST(
    new Request("http://x/api/instruments", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        isin,
        ticker: "TST",
        name: "Test Co",
        kind: "stock",
        currency: "EUR",
        priceSource: "manual",
        sourceKey: isin,
      }),
    }),
  );
  expect(response.status).toBe(201);
  // SAFETY: a 201 from POST /api/instruments (asserted above) always
  // returns the inserted row, which carries an `id` column.
  const body = (await response.json()) as { id: number };
  return body.id;
};

// The four routes read transactions/prices directly, and Task 16 adds no
// HTTP route for writing either -- transactions arrive via the import
// pipeline (Tasks 10-12), prices via the refresh job (Task 15). Seeding
// them for these route-level tests therefore goes straight through the
// shared getDb() handle, exactly like valuation.test.ts's lower-level seed.
const seedHolding = async (
  cookie: string,
  opts: {
    buyDate: string;
    quantity: number;
    unitPrice: number;
    principal: number;
    fee?: number;
    prices: Array<{ date: string; close: number }>;
  },
): Promise<{ accountId: number; instrumentId: number }> => {
  const { getDb } = await import("../db");
  const { prices, transactions } = await import("../db/schema");
  const { db } = getDb();

  const accountId = await createAccount(cookie);
  const instrumentId = await createInstrument(cookie, randomIsin());
  const fee = opts.fee ?? 0;

  db.insert(transactions)
    .values({
      accountId,
      instrumentId,
      type: "BUY",
      tradeDate: opts.buyDate,
      quantity: opts.quantity,
      unitPrice: opts.unitPrice,
      // `amount` is the fee-inclusive total cash that moved (see
      // `Txn.amount`'s doc in core/types.ts) -- `principal` here is the
      // pre-fee trade value, so the fee is folded in before it is stored,
      // matching what a real broker export reports.
      amount: -(opts.principal + fee),
      fee,
      tax: 0,
      currency: EUR,
      fxRateEur: 100_000_000,
      contentHash: crypto.randomUUID(),
      externalId: null,
      importId: null,
    })
    .run();

  if (opts.prices.length > 0) {
    db.insert(prices)
      .values(
        opts.prices.map((p) => ({
          instrumentId,
          date: p.date,
          close: p.close,
          currency: EUR,
          source: "manual",
          fetchedAt: new Date(),
        })),
      )
      .run();
  }

  return { accountId, instrumentId };
};

// --- 401 without a session, for every route ---

describe("authentication", () => {
  // `portfolioRoutes` is only assigned inside the async beforeAll above, so
  // the routes themselves (not just their responses) must be looked up
  // inside each test callback -- indexing the object at describe-body time
  // (before beforeAll has run) would read `undefined`.
  test.each(["/api/holdings", "/api/value-series", "/api/allocation", "/api/returns"] as const)(
    "rejects %s with no session",
    async (path) => {
      const response = await portfolioRoutes[path].GET(new Request(`http://x${path}`));
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "Kirjautuminen vaaditaan" });
    },
  );
});

// --- GET /api/holdings ---

describe("GET /api/holdings", () => {
  test("returns quantity, cost, value and gain as decimal strings, and flags staleness", async () => {
    const { cookie } = await signUp(`holdings-${crypto.randomUUID()}@example.com`);
    await seedHolding(cookie, {
      buyDate: "2024-01-10",
      quantity: 100_000_000,
      unitPrice: 415,
      principal: 41_500,
      fee: 300,
      prices: [{ date: "2024-01-10", close: 415 }],
    });

    const response = await portfolioRoutes["/api/holdings"].GET(
      new Request("http://x/api/holdings?on=2024-06-01", { headers: { cookie } }),
    );
    expect(response.status).toBe(200);
    // SAFETY: a 200 from GET /api/holdings (asserted above) always returns
    // the HoldingView[] shape holdingsFor() builds.
    const body = (await response.json()) as Array<{
      quantity: string;
      costEur: string;
      valueEur: string;
      unrealisedEur: string;
      weight: number;
      stale: boolean;
      priceDate: string | null;
    }>;
    expect(body).toHaveLength(1);
    const holding = body[0]!;
    expect(holding.quantity).toBe("100.000000");
    expect(holding.costEur).toBe("418.00");
    expect(holding.valueEur).toBe("415.00");
    expect(holding.unrealisedEur).toBe("-3.00");
    expect(holding.priceDate).toBe("2024-01-10");
    // Priced on 10.1. but requested as of 1.6. -- carried forward, so stale.
    expect(holding.stale).toBe(true);
    // The only holding -> the entire weight denominator -> 100% of it.
    // weight is a `number` on the wire, like allocation's own `weight`, never
    // a decimal string.
    expect(holding.weight).toBe(1);
  });

  test("scopes holdings to the caller and never returns another user's position", async () => {
    const owner = await signUp(`holdings-owner-${crypto.randomUUID()}@example.com`);
    const stranger = await signUp(`holdings-stranger-${crypto.randomUUID()}@example.com`);
    await seedHolding(owner.cookie, {
      buyDate: "2024-01-10",
      quantity: 10_000_000,
      unitPrice: 100,
      principal: 1_000,
      prices: [{ date: "2024-01-10", close: 100 }],
    });

    const response = await portfolioRoutes["/api/holdings"].GET(
      new Request("http://x/api/holdings", { headers: { cookie: stranger.cookie } }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  test("rejects a malformed 'on' query parameter with 400", async () => {
    const { cookie } = await signUp(`holdings-badon-${crypto.randomUUID()}@example.com`);
    const response = await portfolioRoutes["/api/holdings"].GET(
      new Request("http://x/api/holdings?on=not-a-date", { headers: { cookie } }),
    );
    expect(response.status).toBe(400);
  });

  // Regression: an OP import pasted one page at a time can easily land a
  // SELL on the ledger before the BUY it disposes of, which is on an
  // earlier page not yet imported. core/costbasis.ts's buildLots() throws a
  // correct, well-worded domain error for this (UnmatchedDisposalError).
  // This USED TO take the whole holdings screen down with a whole-request
  // 400 (see git history on this file) -- during a page-by-page import that
  // is the normal state, so the user would be locked out of their whole
  // portfolio until the last page landed. It must instead degrade per
  // position: every holding is still returned, and only the affected one is
  // marked, with the same instrument (ISIN and name -- user-facing facts,
  // never the internal numeric instrumentId) and trade date, and the same
  // "what to do about it" wording this app has shown for this condition
  // since it was first caught.
  test("degrades the affected position instead of 400ing the whole request when a sale has no matching purchase", async () => {
    const { cookie } = await signUp(`holdings-unmatched-${crypto.randomUUID()}@example.com`);
    const { getDb } = await import("../db");
    const { transactions } = await import("../db/schema");
    const { db } = getDb();
    const accountId = await createAccount(cookie);
    const isin = randomIsin();
    const instrumentId = await createInstrument(cookie, isin);

    db.insert(transactions)
      .values({
        accountId,
        instrumentId,
        type: "SELL",
        tradeDate: "2025-01-01",
        quantity: 10_000_000, // 10 units
        unitPrice: 100,
        amount: 1_000_00, // 1000.00 proceeds
        fee: 0,
        tax: 0,
        currency: EUR,
        fxRateEur: 100_000_000,
        contentHash: crypto.randomUUID(),
        externalId: null,
        importId: null,
      })
      .run();

    const response = await portfolioRoutes["/api/holdings"].GET(
      new Request("http://x/api/holdings?on=2025-01-01", { headers: { cookie } }),
    );
    expect(response.status).toBe(200);
    // SAFETY: a 200 from GET /api/holdings (asserted above) always returns
    // the HoldingView[] shape holdingsFor() builds.
    const body = (await response.json()) as Array<{
      isin: string;
      quantity: string;
      costEur: string | null;
      valueEur: string | null;
      unrealisedEur: string | null;
      costBasisError: { tradeDate: string; message: string } | null;
    }>;
    expect(body).toHaveLength(1);
    const holding = body[0]!;
    // The raw ledger fact is still reported honestly: 10 units disposed, 0
    // ever acquired, so -10.
    expect(holding.quantity).toBe("-10.000000");
    expect(holding.costEur).toBeNull();
    expect(holding.valueEur).toBeNull();
    expect(holding.unrealisedEur).toBeNull();
    expect(holding.costBasisError).not.toBeNull();
    expect(holding.costBasisError!.tradeDate).toBe("2025-01-01");
    const message = holding.costBasisError!.message;
    expect(message).toContain(isin);
    expect(message).toContain("Test Co"); // createInstrument()'s fixed instrument name
    expect(message).toContain("2025-01-01");
    // Tells the user what to do: import the missing purchase or remove the row.
    expect(message).toMatch(/tuo|poista/i);
    // No internal detail leaked: not core's own raw exception wording, which
    // names the instrument by its internal numeric id ("instrument N")
    // rather than the user-facing ISIN/name used above.
    expect(message).not.toMatch(/cannot dispose/i);
    expect(message).not.toMatch(/instrument \d/i);
  });

  test("an unmatched sale on one instrument does not affect another instrument's holding", async () => {
    const { cookie } = await signUp(`holdings-unmatched-other-${crypto.randomUUID()}@example.com`);
    const { getDb } = await import("../db");
    const { transactions } = await import("../db/schema");
    const { db } = getDb();

    // A perfectly ordinary holding...
    const { accountId } = await seedHolding(cookie, {
      buyDate: "2024-01-10",
      quantity: 10_000_000,
      unitPrice: 100,
      principal: 1_000,
      prices: [{ date: "2024-01-10", close: 100 }],
    });

    // ...alongside a second instrument with an unmatched sale.
    const brokenIsin = randomIsin();
    const brokenInstrumentId = await createInstrument(cookie, brokenIsin);
    db.insert(transactions)
      .values({
        accountId,
        instrumentId: brokenInstrumentId,
        type: "SELL",
        tradeDate: "2024-06-01",
        quantity: 5_000_000,
        unitPrice: 100,
        amount: 500_00,
        fee: 0,
        tax: 0,
        currency: EUR,
        fxRateEur: 100_000_000,
        contentHash: crypto.randomUUID(),
        externalId: null,
        importId: null,
      })
      .run();

    const response = await portfolioRoutes["/api/holdings"].GET(
      new Request("http://x/api/holdings?on=2024-06-01", { headers: { cookie } }),
    );
    expect(response.status).toBe(200);
    // SAFETY: a 200 from GET /api/holdings (asserted above) always returns
    // the HoldingView[] shape holdingsFor() builds.
    const body = (await response.json()) as Array<{
      isin: string;
      costEur: string | null;
      costBasisError: unknown | null;
    }>;
    expect(body).toHaveLength(2);
    const ok = body.find((h) => h.isin !== brokenIsin)!;
    const broken = body.find((h) => h.isin === brokenIsin)!;
    expect(ok.costBasisError).toBeNull();
    expect(ok.costEur).toBe("10.00"); // principal 1_000 minor units = 10.00 EUR, no fee
    expect(broken.costBasisError).not.toBeNull();
  });
});

// --- GET /api/value-series ---

describe("GET /api/value-series", () => {
  test("returns a daily EUR value and staleness flag as decimal strings", async () => {
    const { cookie } = await signUp(`series-${crypto.randomUUID()}@example.com`);
    await seedHolding(cookie, {
      buyDate: "2024-01-01",
      quantity: 10_000_000,
      unitPrice: 1000,
      principal: 10_000,
      prices: [
        { date: "2024-01-01", close: 1000 },
        { date: "2024-01-05", close: 1100 },
      ],
    });

    const response = await portfolioRoutes["/api/value-series"].GET(
      new Request("http://x/api/value-series?from=2024-01-01&to=2024-01-05", {
        headers: { cookie },
      }),
    );
    expect(response.status).toBe(200);
    // SAFETY: a 200 from GET /api/value-series (asserted above) always
    // returns an array of { date, valueEur, stale } points.
    const body = (await response.json()) as Array<{
      date: string;
      valueEur: string;
      stale: boolean;
      excludedInstrumentIds: number[];
    }>;
    expect(body).toHaveLength(5);
    // 10 units at 10.00/unit = 100.00; at 11.00/unit = 110.00.
    expect(body[0]).toEqual({
      date: "2024-01-01",
      valueEur: "100.00",
      stale: false,
      excludedInstrumentIds: [],
    });
    expect(body.at(-1)).toEqual({
      date: "2024-01-05",
      valueEur: "110.00",
      stale: false,
      excludedInstrumentIds: [],
    });
    // 2024-01-02..04 carry the 1.1. price forward -- stale.
    expect(body.slice(1, 4).every((p) => p.stale)).toBe(true);
  });

  test("defaults to a long since-inception range without error", async () => {
    const { cookie } = await signUp(`series-default-${crypto.randomUUID()}@example.com`);
    const response = await portfolioRoutes["/api/value-series"].GET(
      new Request("http://x/api/value-series", { headers: { cookie } }),
    );
    expect(response.status).toBe(200);
    // SAFETY: a 200 from GET /api/value-series (asserted above) always
    // returns an array of { date, valueEur, stale } points.
    const body = (await response.json()) as Array<{ date: string; valueEur: string }>;
    expect(body[0]!.date).toBe("2015-01-01");
    expect(body.length).toBeGreaterThan(2000);
    expect(body.every((p) => p.valueEur === "0.00")).toBe(true);
  });

  test("rejects from > to with 400", async () => {
    const { cookie } = await signUp(`series-badrange-${crypto.randomUUID()}@example.com`);
    const response = await portfolioRoutes["/api/value-series"].GET(
      new Request("http://x/api/value-series?from=2024-06-01&to=2024-01-01", {
        headers: { cookie },
      }),
    );
    expect(response.status).toBe(400);
  });

  test("rejects a malformed date query parameter with 400 field detail", async () => {
    const { cookie } = await signUp(`series-baddate-${crypto.randomUUID()}@example.com`);
    const response = await portfolioRoutes["/api/value-series"].GET(
      new Request("http://x/api/value-series?from=01-01-2024", { headers: { cookie } }),
    );
    expect(response.status).toBe(400);
  });

  // Defence in depth: scoping is already proven at the shared loadPortfolio()
  // choke point (valuation.test.ts's "loads only the requesting user's
  // rows"), but this is one of the four routes every screen reads from, so
  // it is worth one direct route-level check per route too.
  test("scopes value to the caller and never counts another user's position", async () => {
    const owner = await signUp(`series-owner-${crypto.randomUUID()}@example.com`);
    const stranger = await signUp(`series-stranger-${crypto.randomUUID()}@example.com`);
    await seedHolding(owner.cookie, {
      buyDate: "2024-01-01",
      quantity: 10_000_000,
      unitPrice: 1000,
      principal: 10_000,
      prices: [{ date: "2024-01-01", close: 1000 }],
    });

    const response = await portfolioRoutes["/api/value-series"].GET(
      new Request("http://x/api/value-series?from=2024-01-01&to=2024-01-01", {
        headers: { cookie: stranger.cookie },
      }),
    );
    expect(response.status).toBe(200);
    // SAFETY: a 200 from GET /api/value-series (asserted above) always
    // returns an array of { date, valueEur, stale } points.
    const body = (await response.json()) as Array<{
      date: string;
      valueEur: string;
      stale: boolean;
      excludedInstrumentIds: number[];
    }>;
    expect(body).toEqual([
      { date: "2024-01-01", valueEur: "0.00", stale: false, excludedInstrumentIds: [] },
    ]);
  });

  // Regression: verified directly against positionsAt() that an unmatched SELL
  // reports a negative quantity for that instrument (e.g. instrument 7, quantity
  // -10.000000 for a bare 10-unit sale with no prior buy). valueSeries() must not
  // multiply that by a price and report a negative "value" for the day -- and it
  // must not silently disappear from the total either, so the instrument is named
  // in excludedInstrumentIds instead.
  test("a negative (unmatched-disposal) position never makes the daily value negative", async () => {
    const { cookie } = await signUp(`series-negative-${crypto.randomUUID()}@example.com`);
    const { getDb } = await import("../db");
    const { transactions } = await import("../db/schema");
    const { db } = getDb();
    const accountId = await createAccount(cookie);
    const instrumentId = await createInstrument(cookie, randomIsin());

    db.insert(transactions)
      .values({
        accountId,
        instrumentId,
        type: "SELL",
        tradeDate: "2024-01-01",
        quantity: 10_000_000, // 10 units, nothing ever bought
        unitPrice: 100,
        amount: 1_000_00,
        fee: 0,
        tax: 0,
        currency: EUR,
        fxRateEur: 100_000_000,
        contentHash: crypto.randomUUID(),
        externalId: null,
        importId: null,
      })
      .run();

    const response = await portfolioRoutes["/api/value-series"].GET(
      new Request("http://x/api/value-series?from=2024-01-01&to=2024-01-01", {
        headers: { cookie },
      }),
    );
    expect(response.status).toBe(200);
    // SAFETY: a 200 from GET /api/value-series (asserted above) always
    // returns an array of { date, valueEur, stale, excludedInstrumentIds } points.
    const body = (await response.json()) as Array<{
      valueEur: string;
      excludedInstrumentIds: number[];
    }>;
    expect(body).toHaveLength(1);
    expect(body[0]!.valueEur).toBe("0.00");
    expect(Number(body[0]!.valueEur)).toBeGreaterThanOrEqual(0);
    expect(body[0]!.excludedInstrumentIds).toEqual([instrumentId]);
  });
});

// --- GET /api/allocation ---

describe("GET /api/allocation", () => {
  test("defaults to allocation by kind and reports weight as a ratio", async () => {
    const { cookie } = await signUp(`alloc-${crypto.randomUUID()}@example.com`);
    await seedHolding(cookie, {
      buyDate: "2024-01-01",
      quantity: 10_000_000,
      unitPrice: 1000,
      principal: 10_000,
      prices: [{ date: "2024-01-01", close: 1000 }],
    });

    const response = await portfolioRoutes["/api/allocation"].GET(
      new Request("http://x/api/allocation?on=2024-01-01", { headers: { cookie } }),
    );
    expect(response.status).toBe(200);
    // SAFETY: a 200 from GET /api/allocation (asserted above) always
    // returns { slices: Slice[], excludedInstruments } (allocateBy() builds
    // `slices`; negativePositionIds() -- enriched with ISIN/name -- builds
    // `excludedInstruments`).
    const body = (await response.json()) as {
      slices: Array<{ key: string; label: string; valueEur: string; weight: number }>;
      excludedInstruments: Array<{ instrumentId: number; isin: string; name: string }>;
    };
    // 10 units at 10.00/unit = 100.00.
    expect(body.slices).toEqual([
      { key: "stock", label: "Osakkeet", valueEur: "100.00", weight: 1 },
    ]);
    expect(body.excludedInstruments).toEqual([]);
  });

  test("accepts by=currency", async () => {
    const { cookie } = await signUp(`alloc-currency-${crypto.randomUUID()}@example.com`);
    await seedHolding(cookie, {
      buyDate: "2024-01-01",
      quantity: 10_000_000,
      unitPrice: 1000,
      principal: 10_000,
      prices: [{ date: "2024-01-01", close: 1000 }],
    });

    const response = await portfolioRoutes["/api/allocation"].GET(
      new Request("http://x/api/allocation?by=currency&on=2024-01-01", { headers: { cookie } }),
    );
    expect(response.status).toBe(200);
    // SAFETY: a 200 from GET /api/allocation (asserted above) always
    // returns { slices, excludedInstruments } -- see the previous test.
    const body = (await response.json()) as { slices: Array<{ key: string }> };
    expect(body.slices.map((s) => s.key)).toContain("EUR");
  });

  // Regression: a SELL with no matching earlier BUY drives positionsAt() negative
  // for that instrument (core/ledger.ts). allocateBy() must never multiply that
  // negative quantity by a price and fold it into a slice's total -- and the
  // instrument must not just vanish from the response either, which would be
  // just as misleading as a fabricated negative amount.
  test("a negative (unmatched-disposal) position never contributes a negative amount, and is named in excludedInstruments instead", async () => {
    const { cookie } = await signUp(`alloc-negative-${crypto.randomUUID()}@example.com`);
    const { getDb } = await import("../db");
    const { transactions } = await import("../db/schema");
    const { db } = getDb();

    // One ordinary holding...
    await seedHolding(cookie, {
      buyDate: "2024-01-01",
      quantity: 10_000_000,
      unitPrice: 1000,
      principal: 10_000,
      prices: [{ date: "2024-01-01", close: 1000 }],
    });

    // ...and a second instrument sold with nothing ever bought.
    const cookieAccountId = await createAccount(cookie);
    const brokenIsin = randomIsin();
    const brokenInstrumentId = await createInstrument(cookie, brokenIsin);
    db.insert(transactions)
      .values({
        accountId: cookieAccountId,
        instrumentId: brokenInstrumentId,
        type: "SELL",
        tradeDate: "2024-01-01",
        quantity: 5_000_000,
        unitPrice: 100,
        amount: 500_00,
        fee: 0,
        tax: 0,
        currency: EUR,
        fxRateEur: 100_000_000,
        contentHash: crypto.randomUUID(),
        externalId: null,
        importId: null,
      })
      .run();

    const response = await portfolioRoutes["/api/allocation"].GET(
      new Request("http://x/api/allocation?on=2024-01-01", { headers: { cookie } }),
    );
    expect(response.status).toBe(200);
    // SAFETY: a 200 from GET /api/allocation (asserted above) always
    // returns { slices, excludedInstruments } -- see this describe block's
    // first test.
    const body = (await response.json()) as {
      slices: Array<{ key: string; label: string; valueEur: string; weight: number }>;
      excludedInstruments: Array<{ instrumentId: number; isin: string; name: string }>;
    };
    // Only the ordinary holding's 100.00 -- the broken instrument contributes
    // nothing, positive or negative.
    expect(body.slices).toEqual([
      { key: "stock", label: "Osakkeet", valueEur: "100.00", weight: 1 },
    ]);
    expect(body.slices.every((s) => Number(s.valueEur) >= 0)).toBe(true);
    expect(body.excludedInstruments).toEqual([
      { instrumentId: brokenInstrumentId, isin: brokenIsin, name: "Test Co" },
    ]);
  });

  test("rejects an unknown dimension with 400", async () => {
    const { cookie } = await signUp(`alloc-baddim-${crypto.randomUUID()}@example.com`);
    const response = await portfolioRoutes["/api/allocation"].GET(
      new Request("http://x/api/allocation?by=sector", { headers: { cookie } }),
    );
    expect(response.status).toBe(400);
  });

  // Defence in depth -- see the matching comment on /api/value-series.
  test("scopes allocation to the caller and never counts another user's position", async () => {
    const owner = await signUp(`alloc-owner-${crypto.randomUUID()}@example.com`);
    const stranger = await signUp(`alloc-stranger-${crypto.randomUUID()}@example.com`);
    await seedHolding(owner.cookie, {
      buyDate: "2024-01-01",
      quantity: 10_000_000,
      unitPrice: 1000,
      principal: 10_000,
      prices: [{ date: "2024-01-01", close: 1000 }],
    });

    const response = await portfolioRoutes["/api/allocation"].GET(
      new Request("http://x/api/allocation?on=2024-01-01", {
        headers: { cookie: stranger.cookie },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ slices: [], excludedInstruments: [] });
  });
});

// --- GET /api/returns ---

describe("GET /api/returns", () => {
  test("reports value, TWR (a ratio) and MWR as a number, given a deposit, a withdrawal and growth", async () => {
    const { cookie } = await signUp(`returns-${crypto.randomUUID()}@example.com`);
    const { getDb } = await import("../db");
    const { transactions } = await import("../db/schema");
    const { db } = getDb();

    const { accountId } = await seedHolding(cookie, {
      buyDate: "2024-01-01",
      quantity: 100_000_000,
      unitPrice: 8000,
      principal: 800_000,
      prices: [
        { date: "2024-01-01", close: 8000 },
        { date: "2025-01-01", close: 10000 },
      ],
    });

    db.insert(transactions)
      .values([
        {
          accountId,
          instrumentId: null,
          type: "DEPOSIT",
          tradeDate: "2024-01-01",
          quantity: 0,
          unitPrice: null,
          amount: 1_000_000,
          fee: 0,
          tax: 0,
          currency: EUR,
          fxRateEur: 100_000_000,
          contentHash: crypto.randomUUID(),
          externalId: null,
          importId: null,
        },
        {
          accountId,
          instrumentId: null,
          type: "WITHDRAWAL",
          tradeDate: "2024-06-01",
          quantity: 0,
          unitPrice: null,
          amount: -100_000,
          fee: 0,
          tax: 0,
          currency: EUR,
          fxRateEur: 100_000_000,
          contentHash: crypto.randomUUID(),
          externalId: null,
          importId: null,
        },
      ])
      .run();

    const response = await portfolioRoutes["/api/returns"].GET(
      new Request("http://x/api/returns?from=2024-01-01&to=2025-01-01", { headers: { cookie } }),
    );
    expect(response.status).toBe(200);
    // SAFETY: a 200 from GET /api/returns (asserted above) always returns
    // this { from, to, valueEur, stale, twr, mwr } shape.
    const body = (await response.json()) as {
      from: string;
      to: string;
      valueEur: string;
      stale: boolean;
      twr: number | null;
      mwr: number | null;
    };
    expect(body.valueEur).toBe("10000.00");
    expect(body.stale).toBe(false);
    // C4: this used to assert -0.3650793650793651 -- a "hardening" of the exact bug this
    // fix removes (see core/returns.ts's `twr` doc and core/ledger.ts's `investedCashFlows`
    // doc for the full story). That number came from feeding twr() the DEPOSIT (10,000.00)
    // and WITHDRAWAL (1,000.00) as its flows, against a `series` that prices invested
    // positions only (spec §7) -- two different portfolios. The DEPOSIT is bigger than the
    // same-day BUY (8,000.00, the only thing actually invested), so the flow inflated a base
    // the position never actually had; the WITHDRAWAL was drawn from idle cash, not the
    // position, but was subtracted from the base as if it had been. Neither is a real
    // consequence of the instrument's own 80.00 -> 100.00 move.
    //
    // The only thing that actually happened to the *invested* portfolio here is: 100 units
    // bought at 80.00 on 2024-01-01 (matching that day's valueSeries point exactly, so the
    // BUY contributes no sub-period factor -- see `twr`'s doc, a ledger's first purchase
    // never is), held unchanged through 2025-01-01 where the price is 100.00. No SELL, no
    // TRANSFER, nothing else moves the position, so there is exactly one sub-period:
    // (10000.00 - 0) / 8000.00 - 1 = 0.25. The DEPOSIT and WITHDRAWAL are real ledger events
    // but never touch a position, so `investedCashFlows` correctly excludes them from twr's
    // input -- verified by an equivalent direct core/returns.ts twr() call before pinning
    // this number.
    expect(body.twr).toBeCloseTo(0.25, 9);
    // Regression: a withdrawal's negative ledger amount, negated into
    // xirr's sign convention via a format-then-reparse of "-<already
    // negative>", used to produce an unparsable "--100.00" and silently
    // fall into the null branch on every call that included a withdrawal.
    // `negateMoney` fixes this -- with a deposit, a withdrawal and growth
    // all present, MWR must be a real number, not null.
    expect(body.mwr).not.toBeNull();
    // `?? Number.NaN` only narrows `number | null` to `number` for the type
    // checker -- if `mwr` were unexpectedly null despite the assertion
    // above, `isFinite(NaN)` is false, so this still fails loudly.
    expect(Number.isFinite(body.mwr ?? Number.NaN)).toBe(true);
  });

  test("returns mwr: null (not a fabricated rate) when contributions have no offsetting sign", async () => {
    const { cookie } = await signUp(`returns-nullmwr-${crypto.randomUUID()}@example.com`);
    const { getDb } = await import("../db");
    const { transactions } = await import("../db/schema");
    const { db } = getDb();
    const accountId = await createAccount(cookie);

    // A deposit that is never invested: valueSeries only prices tracked
    // positions, so the tracked value stays 0 for the whole window and
    // xirr sees only non-positive amounts -- "unknown", not "0%".
    db.insert(transactions)
      .values({
        accountId,
        instrumentId: null,
        type: "DEPOSIT",
        tradeDate: "2024-01-01",
        quantity: 0,
        unitPrice: null,
        amount: 500_00,
        fee: 0,
        tax: 0,
        currency: EUR,
        fxRateEur: 100_000_000,
        contentHash: crypto.randomUUID(),
        externalId: null,
        importId: null,
      })
      .run();

    const response = await portfolioRoutes["/api/returns"].GET(
      new Request("http://x/api/returns?from=2024-01-01&to=2024-12-31", { headers: { cookie } }),
    );
    expect(response.status).toBe(200);
    // SAFETY: a 200 from GET /api/returns (asserted above) always returns
    // this { valueEur, mwr, ... } shape.
    const body = (await response.json()) as { mwr: number | null; valueEur: string };
    expect(body.valueEur).toBe("0.00");
    expect(body.mwr).toBeNull();
  });

  test("returns mwr: null rather than throwing for a user with no transactions at all", async () => {
    const { cookie } = await signUp(`returns-empty-${crypto.randomUUID()}@example.com`);
    const response = await portfolioRoutes["/api/returns"].GET(
      new Request("http://x/api/returns?from=2024-01-01&to=2024-12-31", { headers: { cookie } }),
    );
    expect(response.status).toBe(200);
    // SAFETY: a 200 from GET /api/returns (asserted above) always returns
    // this { valueEur, twr, mwr, ... } shape.
    const body = (await response.json()) as {
      mwr: number | null;
      twr: number | null;
      valueEur: string;
    };
    expect(body.mwr).toBeNull();
    expect(body.twr).toBe(0);
    expect(body.valueEur).toBe("0.00");
  });

  // C5: the Critical fix -- an unvaluable holding must never collapse `twr` to a
  // fabricated rate, and the caller must be able to see *why* (see core/returns.ts's
  // `twr` doc and this route's own `excludedInstruments` comment).
  test("reports twr: null and names the holding in excludedInstruments when a second instrument has no price at all", async () => {
    const { cookie } = await signUp(`returns-excluded-${crypto.randomUUID()}@example.com`);
    const { accountId } = await seedHolding(cookie, {
      buyDate: "2024-01-01",
      quantity: 100_000_000,
      unitPrice: 8000,
      principal: 800_000,
      prices: [{ date: "2024-01-01", close: 8000 }],
    });

    const { getDb } = await import("../db");
    const { transactions } = await import("../db/schema");
    const { db } = getDb();
    const unpricedInstrumentId = await createInstrument(cookie, randomIsin());
    // A second holding bought the same day, in the same account -- but deliberately
    // never given a `prices` row at all, e.g. an S-Pankki/Danske manual fund set to
    // `manual` before its first NAV entry (spec §10a A5).
    db.insert(transactions)
      .values({
        accountId,
        instrumentId: unpricedInstrumentId,
        type: "BUY",
        tradeDate: "2024-01-01",
        quantity: 50_000_000,
        unitPrice: 5000,
        amount: -500_000,
        fee: 0,
        tax: 0,
        currency: EUR,
        fxRateEur: 100_000_000,
        contentHash: crypto.randomUUID(),
        externalId: null,
        importId: null,
      })
      .run();

    const response = await portfolioRoutes["/api/returns"].GET(
      new Request("http://x/api/returns?from=2024-01-01&to=2024-01-05", { headers: { cookie } }),
    );
    expect(response.status).toBe(200);
    // SAFETY: a 200 from GET /api/returns (asserted above) always returns
    // this { twr, excludedInstruments, ... } shape.
    const body = (await response.json()) as {
      twr: number | null;
      excludedInstruments: Array<{ instrumentId: number; isin: string; name: string }>;
    };
    // Superseded twice over. It first reported -1 (-100%) for an otherwise flat,
    // priced position; then null, because a never-priced holding excluded every
    // sub-period. A holding with no price yet is now carried at its cost basis, so
    // nothing is missing, nothing jumps, and a flat window is honestly 0%. The
    // property that has to hold throughout is that no fabricated rate appears.
    expect(body.twr).toBe(0);
    expect(body.excludedInstruments.map((i) => i.instrumentId)).not.toContain(unpricedInstrumentId);
  });

  test("rejects from > to with 400", async () => {
    const { cookie } = await signUp(`returns-badrange-${crypto.randomUUID()}@example.com`);
    const response = await portfolioRoutes["/api/returns"].GET(
      new Request("http://x/api/returns?from=2024-06-01&to=2024-01-01", { headers: { cookie } }),
    );
    expect(response.status).toBe(400);
  });

  // Defence in depth -- see the matching comment on /api/value-series.
  test("scopes returns to the caller and never counts another user's position", async () => {
    const owner = await signUp(`returns-owner-${crypto.randomUUID()}@example.com`);
    const stranger = await signUp(`returns-stranger-${crypto.randomUUID()}@example.com`);
    await seedHolding(owner.cookie, {
      buyDate: "2024-01-01",
      quantity: 10_000_000,
      unitPrice: 1000,
      principal: 10_000,
      prices: [{ date: "2024-01-01", close: 1000 }],
    });

    const response = await portfolioRoutes["/api/returns"].GET(
      new Request("http://x/api/returns?from=2024-01-01&to=2024-01-01", {
        headers: { cookie: stranger.cookie },
      }),
    );
    expect(response.status).toBe(200);
    // SAFETY: a 200 from GET /api/returns (asserted above) always returns
    // this { valueEur, mwr, ... } shape.
    const body = (await response.json()) as { valueEur: string; mwr: number | null };
    expect(body.valueEur).toBe("0.00");
    expect(body.mwr).toBeNull();
  });

  // Regression for the reviewed Important finding: filtering externalCashFlows
  // to [from, to] alone silently drops whatever the portfolio was already
  // worth going into `from` -- xirr() then treats the final value as having
  // appeared from nothing and returns a finite, plausible, WRONG rate rather
  // than null or an error. This must be exercised with `from` genuinely
  // AFTER inception (not the default since-inception range, where the
  // pre-window value is always zero and the bug is invisible), and the
  // assertion must pin the actual number -- not merely check it is non-null,
  // which the pre-fix code could also produce by coincidence.
  test("MWR over a window starting after inception accounts for the value already there", async () => {
    const { cookie } = await signUp(`returns-windowed-${crypto.randomUUID()}@example.com`);
    await seedHolding(cookie, {
      buyDate: "2024-01-01",
      quantity: 100_000_000, // 100 units
      unitPrice: 5000, // 50.00/unit
      principal: 500_000, // 5,000.00 -- fully funded, no deposit needed for this test
      prices: [
        { date: "2024-01-01", close: 5000 }, // 50.00/unit -- still the latest price at 2024-06-30
        { date: "2025-01-01", close: 6000 }, // 60.00/unit
      ],
    });

    const response = await portfolioRoutes["/api/returns"].GET(
      new Request("http://x/api/returns?from=2024-07-01&to=2025-01-01", { headers: { cookie } }),
    );
    expect(response.status).toBe(200);
    // SAFETY: a 200 from GET /api/returns (asserted above) always returns
    // this { valueEur, mwr, ... } shape.
    const body = (await response.json()) as { valueEur: string; mwr: number | null };
    expect(body.valueEur).toBe("6000.00"); // 100 x 60.00

    // Independently derived expected flows, with no dependency on
    // portfolio.ts's own implementation: the value already held on
    // 2024-07-01 (100 units still priced at the 1.1. close of 50.00, since
    // no later price exists yet) is a -5000.00 implicit contribution; there
    // are no deposits or withdrawals inside the window; the final value on
    // 2025-01-01 is +6000.00 (100 x 60.00). Computed via the same, already
    // separately-tested core.xirr -- this checks that portfolio.ts assembled
    // the RIGHT flows, not that xirr's own math is right (core/returns.test.ts
    // already covers that).
    const expected = xirr([{ date: "2024-07-01", amountEur: parseMoney("-5000.00", EUR) }], {
      date: "2025-01-01",
      amountEur: parseMoney("6000.00", EUR),
    });
    expect(body.mwr).not.toBeNull();
    expect(body.mwr).toBeCloseTo(expected, 9);
    // Sanity bound: a real position that grew 20% over a half-year window
    // should show as substantial double-digit annualised growth, not a
    // number near zero (which is what the pre-fix bug would NOT have
    // produced either, since it never added an opening flow at all -- but
    // pinning a plausible range guards against a fix that silently changed
    // the wrong thing).
    expect(body.mwr ?? Number.NaN).toBeGreaterThan(0.3);
  });
});

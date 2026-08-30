import { beforeAll, describe, expect, test } from "vitest";
import { CreateAccount, openAccount as openAccountRow } from "../accounts.ts";
import { addRules, removeRule, rulesFor } from "../spending/rules.ts";
import { AllocationInput } from "../../web/server/portfolio.ts";
import { Range } from "../../web/server/portfolio.ts";
import { getDb } from "../db/index.ts";
import { holdingsFor } from "../valuation.ts";
import {
  allocationView,
  cashFlowView,
  cashView,
  classifiedView,
  monthlyView,
  returnsView,
  uncategorisedView,
  valueSeriesView,
} from "./portfolio.ts";
import { addInstrument } from "../instruments/store.ts";
import { z } from "zod";
import { EUR, parseMoney } from "../../core/money.ts";
import { xirr } from "../../core/returns.ts";

// Exercises portfolioRoutes (src/server/api/portfolio.ts) against a real,
// migrated database and a real Better Auth session, mirroring
// accounts.test.ts's and instruments.test.ts's setup -- including their
// reliance on ../test-setup.ts (a vitest.config.ts `setupFiles` entry) to
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

/** What the views default to when a caller names no date. */
const today = (): string => new Date().toISOString().slice(0, 10);

let auth: (typeof import("../auth.ts"))["auth"];

beforeAll(async () => {
  const authModule = await import("../auth.ts");
  auth = authModule.auth;
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

const createAccount = (userId: string): number =>
  openAccountRow(getDb().db, userId, CreateAccount.parse({ name: "Nordnet", broker: "nordnet" }))
    .id;

const createInstrument = (isin: string): number => {
  return addInstrument(getDb().db, {
    isin,
    ticker: "TST",
    name: "Test Co",
    kind: "stock",
    currency: EUR,
    priceSource: "manual",
    sourceKey: isin,
  }).id;
};

// The four routes read transactions/prices directly, and Task 16 adds no
// HTTP route for writing either -- transactions arrive via the import
// pipeline (Tasks 10-12), prices via the refresh job (Task 15). Seeding
// them for these route-level tests therefore goes straight through the
// shared getDb() handle, exactly like valuation.test.ts's lower-level seed.
/** The two response shapes the cash tests read, parsed rather than cast. */
const CashSchema = z.object({
  rows: z.array(
    z.object({
      accountId: z.number(),
      accountName: z.string(),
      currency: z.string(),
      amount: z.string(),
      valueEur: z.string().nullable(),
      locked: z.boolean(),
      availableFrom: z.string().nullable(),
    }),
  ),
  totalEur: z.string(),
  availableEur: z.string(),
  lockedEur: z.string(),
});

const AccountIdSchema = z.object({ id: z.number() });

const ReturnsBankSchema = z.object({
  valueEur: z.string(),
  cashEur: z.string(),
  valueWithCashEur: z.string(),
  twr: z.number().nullable(),
  mwr: z.number().nullable(),
});

const ReturnsCashSchema = z.object({
  valueEur: z.string(),
  cashEur: z.string(),
  valueWithCashEur: z.string(),
});

const seedHolding = async (
  userId: string,
  opts: {
    buyDate: string;
    quantity: number;
    unitPrice: number;
    principal: number;
    fee?: number;
    prices: Array<{ date: string; close: number }>;
  },
): Promise<{ accountId: number; instrumentId: number }> => {
  const { getDb } = await import("../db/index.ts");
  const { prices, transactions } = await import("../db/schema.ts");
  const { db } = getDb();

  const accountId = createAccount(userId);
  const instrumentId = createInstrument(randomIsin());
  const fee = opts.fee ?? 0;

  getDb()
    .db.insert(transactions)
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
    getDb()
      .db.insert(prices)
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

// The 401-without-a-session block lived here and went with the routes. Every
// server function that touches the ledger declares the authed middleware, which
// resolves the session or redirects to /login; there is no way to call one
// without it, so there is nothing left for a test to sneak past.

// --- GET /api/holdings ---

describe("GET /api/holdings", () => {
  test("returns quantity, cost, value and gain as decimal strings, and flags staleness", async () => {
    const { userId, cookie } = await signUp(`holdings-${crypto.randomUUID()}@example.com`);
    await seedHolding(userId, {
      buyDate: "2024-01-10",
      quantity: 100_000_000,
      unitPrice: 415,
      principal: 41_500,
      fee: 300,
      prices: [{ date: "2024-01-10", close: 415 }],
    });

    const body = holdingsFor(getDb().db, userId, "2024-06-01");
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
    await seedHolding(owner.userId, {
      buyDate: "2024-01-10",
      quantity: 10_000_000,
      unitPrice: 100,
      principal: 1_000,
      prices: [{ date: "2024-01-10", close: 100 }],
    });

    // The id comes from the session, so a stranger asking is a stranger's
    // own empty portfolio -- not a way to reach someone else's.
    expect(holdingsFor(getDb().db, stranger.userId, today())).toEqual([]);
  });

  // "rejects a malformed 'on' parameter" belonged to the URL. getHoldings takes
  // an ISO date or nothing, so a caller cannot express "not-a-date" -- and the
  // validator refuses it before the handler runs if one somehow does.

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
    const { userId, cookie } = await signUp(
      `holdings-unmatched-${crypto.randomUUID()}@example.com`,
    );
    const { getDb } = await import("../db/index.ts");
    const { transactions } = await import("../db/schema.ts");
    const { db } = getDb();
    const accountId = createAccount(userId);
    const isin = randomIsin();
    const instrumentId = createInstrument(isin);

    getDb()
      .db.insert(transactions)
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

    const body = holdingsFor(getDb().db, userId, "2025-01-01");
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
    const { userId, cookie } = await signUp(
      `holdings-unmatched-other-${crypto.randomUUID()}@example.com`,
    );
    const { getDb } = await import("../db/index.ts");
    const { transactions } = await import("../db/schema.ts");
    const { db } = getDb();

    // A perfectly ordinary holding...
    const { accountId } = await seedHolding(userId, {
      buyDate: "2024-01-10",
      quantity: 10_000_000,
      unitPrice: 100,
      principal: 1_000,
      prices: [{ date: "2024-01-10", close: 100 }],
    });

    // ...alongside a second instrument with an unmatched sale.
    const brokenIsin = randomIsin();
    const brokenInstrumentId = createInstrument(brokenIsin);
    getDb()
      .db.insert(transactions)
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

    const body = holdingsFor(getDb().db, userId, "2024-06-01");
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
    const { userId, cookie } = await signUp(`series-${crypto.randomUUID()}@example.com`);
    await seedHolding(userId, {
      buyDate: "2024-01-01",
      quantity: 10_000_000,
      unitPrice: 1000,
      principal: 10_000,
      prices: [
        { date: "2024-01-01", close: 1000 },
        { date: "2024-01-05", close: 1100 },
      ],
    });

    const body = valueSeriesView(getDb().db, userId, "2024-01-01", "2024-01-05");
    expect(body).toHaveLength(5);
    // 10 units at 10.00/unit = 100.00; at 11.00/unit = 110.00. The purchase
    // cost 100.00 and none of it has come back out, so invested capital is
    // flat across the window -- the gap to `valueEur` is what the chart draws
    // as the return.
    expect(body[0]).toEqual({
      date: "2024-01-01",
      valueEur: "100.00",
      investedEur: "100.00",
      stale: false,
      excludedInstrumentIds: [],
    });
    expect(body.at(-1)).toEqual({
      date: "2024-01-05",
      valueEur: "110.00",
      investedEur: "100.00",
      stale: false,
      excludedInstrumentIds: [],
    });
    // 2024-01-02..04 carry the 1.1. price forward -- stale.
    expect(body.slice(1, 4).every((p) => p.stale)).toBe(true);
  });

  test("without a start date the series begins at the ledger's first day, not 1900", async () => {
    const { userId } = await signUp(`series-start-${crypto.randomUUID()}@example.com`);
    await seedHolding(userId, {
      buyDate: "2024-01-01",
      quantity: 10_000_000,
      unitPrice: 1000,
      principal: 10_000,
      prices: [{ date: "2024-01-01", close: 1000 }],
    });

    const body = valueSeriesView(getDb().db, userId, undefined, "2024-01-03");
    expect(body[0]?.date).toBe("2024-01-01");
    expect(body).toHaveLength(3);
  });

  test("defaults to a long since-inception range without error", async () => {
    const { userId, cookie } = await signUp(`series-default-${crypto.randomUUID()}@example.com`);
    const body = valueSeriesView(getDb().db, userId, "2015-01-01", today());
    expect(body[0]!.date).toBe("2015-01-01");
    expect(body.length).toBeGreaterThan(2000);
    expect(body.every((p) => p.valueEur === "0.00")).toBe(true);
  });

  test("refuses a backwards range", async () => {
    // Kept as a schema test because that is where the rule moved: an empty
    // chart for a typo'd date looks exactly like an empty chart for an empty
    // portfolio, so the refusal has to happen before the query runs.
    expect(Range.safeParse({ from: "2024-06-01", to: "2024-01-01" }).success).toBe(false);
    expect(Range.safeParse({ from: "2024-01-01", to: "2024-06-01" }).success).toBe(true);
  });

  test("refuses a date that is not one", () => {
    expect(Range.safeParse({ from: "01-01-2024" }).success).toBe(false);
  });

  // Defence in depth: scoping is already proven at the shared loadPortfolio()
  // choke point (valuation.test.ts's "loads only the requesting user's
  // rows"), but this is one of the four routes every screen reads from, so
  // it is worth one direct route-level check per route too.
  test("scopes value to the caller and never counts another user's position", async () => {
    const owner = await signUp(`series-owner-${crypto.randomUUID()}@example.com`);
    const stranger = await signUp(`series-stranger-${crypto.randomUUID()}@example.com`);
    await seedHolding(owner.userId, {
      buyDate: "2024-01-01",
      quantity: 10_000_000,
      unitPrice: 1000,
      principal: 10_000,
      prices: [{ date: "2024-01-01", close: 1000 }],
    });

    const body = valueSeriesView(getDb().db, stranger.userId, "2024-01-01", "2024-01-01");
    // Nothing of the owner's leaks into a stranger's series -- neither what it
    // is worth nor what was put into it.
    expect(body).toEqual([
      {
        date: "2024-01-01",
        valueEur: "0.00",
        investedEur: "0.00",
        stale: false,
        excludedInstrumentIds: [],
      },
    ]);
  });

  // Regression: verified directly against positionsAt() that an unmatched SELL
  // reports a negative quantity for that instrument (e.g. instrument 7, quantity
  // -10.000000 for a bare 10-unit sale with no prior buy). valueSeries() must not
  // multiply that by a price and report a negative "value" for the day -- and it
  // must not silently disappear from the total either, so the instrument is named
  // in excludedInstrumentIds instead.
  test("a negative (unmatched-disposal) position never makes the daily value negative", async () => {
    const { userId, cookie } = await signUp(`series-negative-${crypto.randomUUID()}@example.com`);
    const { getDb } = await import("../db/index.ts");
    const { transactions } = await import("../db/schema.ts");
    const { db } = getDb();
    const accountId = createAccount(userId);
    const instrumentId = createInstrument(randomIsin());

    getDb()
      .db.insert(transactions)
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

    const body = valueSeriesView(getDb().db, userId, "2024-01-01", "2024-01-01");
    expect(body).toHaveLength(1);
    expect(body[0]!.valueEur).toBe("0.00");
    expect(Number(body[0]!.valueEur)).toBeGreaterThanOrEqual(0);
    expect(body[0]!.excludedInstrumentIds).toEqual([instrumentId]);
  });
});

// --- GET /api/allocation ---

describe("GET /api/allocation", () => {
  test("defaults to allocation by kind and reports weight as a ratio", async () => {
    const { userId, cookie } = await signUp(`alloc-${crypto.randomUUID()}@example.com`);
    await seedHolding(userId, {
      buyDate: "2024-01-01",
      quantity: 10_000_000,
      unitPrice: 1000,
      principal: 10_000,
      prices: [{ date: "2024-01-01", close: 1000 }],
    });

    const body = allocationView(getDb().db, userId, "kind", "2024-01-01");
    // 10 units at 10.00/unit = 100.00.
    expect(body.slices).toEqual([
      { key: "stock", label: "Osakkeet", valueEur: "100.00", weight: 1 },
    ]);
    expect(body.excludedInstruments).toEqual([]);
  });

  test("accepts by=currency", async () => {
    const { userId, cookie } = await signUp(`alloc-currency-${crypto.randomUUID()}@example.com`);
    await seedHolding(userId, {
      buyDate: "2024-01-01",
      quantity: 10_000_000,
      unitPrice: 1000,
      principal: 10_000,
      prices: [{ date: "2024-01-01", close: 1000 }],
    });

    const body = allocationView(getDb().db, userId, "currency", "2024-01-01");
    expect(body.slices.map((s) => s.key)).toContain("EUR");
  });

  // Regression: a SELL with no matching earlier BUY drives positionsAt() negative
  // for that instrument (core/ledger.ts). allocateBy() must never multiply that
  // negative quantity by a price and fold it into a slice's total -- and the
  // instrument must not just vanish from the response either, which would be
  // just as misleading as a fabricated negative amount.
  test("a negative (unmatched-disposal) position never contributes a negative amount, and is named in excludedInstruments instead", async () => {
    const { userId, cookie } = await signUp(`alloc-negative-${crypto.randomUUID()}@example.com`);
    const { getDb } = await import("../db/index.ts");
    const { transactions } = await import("../db/schema.ts");
    const { db } = getDb();

    // One ordinary holding...
    await seedHolding(userId, {
      buyDate: "2024-01-01",
      quantity: 10_000_000,
      unitPrice: 1000,
      principal: 10_000,
      prices: [{ date: "2024-01-01", close: 1000 }],
    });

    // ...and a second instrument sold with nothing ever bought.
    const cookieAccountId = createAccount(userId);
    const brokenIsin = randomIsin();
    const brokenInstrumentId = createInstrument(brokenIsin);
    getDb()
      .db.insert(transactions)
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

    const body = allocationView(getDb().db, userId, "kind", "2024-01-01");
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

  test("refuses a grouping that is not one", () => {
    // "sector" is not a slicing this app has. It used to reach the handler as a
    // string and be rejected there; now the argument type is the union, so the
    // line below does not compile -- and the validator refuses it at the edge
    // for anything that arrives from outside TypeScript.
    expect(AllocationInput.safeParse({ by: "sector" }).success).toBe(false);
    expect(AllocationInput.safeParse({ by: "currency" }).success).toBe(true);
  });

  // Defence in depth -- see the matching comment on /api/value-series.
  test("scopes allocation to the caller and never counts another user's position", async () => {
    const owner = await signUp(`alloc-owner-${crypto.randomUUID()}@example.com`);
    const stranger = await signUp(`alloc-stranger-${crypto.randomUUID()}@example.com`);
    await seedHolding(owner.userId, {
      buyDate: "2024-01-01",
      quantity: 10_000_000,
      unitPrice: 1000,
      principal: 10_000,
      prices: [{ date: "2024-01-01", close: 1000 }],
    });

    const response = allocationView(getDb().db, stranger.userId, "kind", "2024-01-01");
    expect(response).toEqual({ slices: [], excludedInstruments: [] });
  });
});

// --- GET /api/returns ---

describe("GET /api/returns", () => {
  test("reports value, TWR (a ratio) and MWR as a number, given a deposit, a withdrawal and growth", async () => {
    const { userId, cookie } = await signUp(`returns-${crypto.randomUUID()}@example.com`);
    const { getDb } = await import("../db/index.ts");
    const { transactions } = await import("../db/schema.ts");
    const { db } = getDb();

    const { accountId } = await seedHolding(userId, {
      buyDate: "2024-01-01",
      quantity: 100_000_000,
      unitPrice: 8000,
      principal: 800_000,
      prices: [
        { date: "2024-01-01", close: 8000 },
        { date: "2025-01-01", close: 10000 },
      ],
    });

    getDb()
      .db.insert(transactions)
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

    const body = returnsView(getDb().db, userId, "2024-01-01", "2025-01-01");
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
    const { userId, cookie } = await signUp(`returns-nullmwr-${crypto.randomUUID()}@example.com`);
    const { getDb } = await import("../db/index.ts");
    const { transactions } = await import("../db/schema.ts");
    const { db } = getDb();
    const accountId = createAccount(userId);

    // A deposit that is never invested: valueSeries only prices tracked
    // positions, so the tracked value stays 0 for the whole window and
    // xirr sees only non-positive amounts -- "unknown", not "0%".
    getDb()
      .db.insert(transactions)
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

    const body = returnsView(getDb().db, userId, "2024-01-01", "2024-12-31");
    expect(body.valueEur).toBe("0.00");
    expect(body.mwr).toBeNull();
  });

  test("returns mwr: null rather than throwing for a user with no transactions at all", async () => {
    const { userId, cookie } = await signUp(`returns-empty-${crypto.randomUUID()}@example.com`);
    const body = returnsView(getDb().db, userId, "2024-01-01", "2024-12-31");
    expect(body.mwr).toBeNull();
    expect(body.twr).toBe(0);
    expect(body.valueEur).toBe("0.00");
  });

  // C5: the Critical fix -- an unvaluable holding must never collapse `twr` to a
  // fabricated rate, and the caller must be able to see *why* (see core/returns.ts's
  // `twr` doc and this route's own `excludedInstruments` comment).
  test("reports twr: null and names the holding in excludedInstruments when a second instrument has no price at all", async () => {
    const { userId, cookie } = await signUp(`returns-excluded-${crypto.randomUUID()}@example.com`);
    const { accountId } = await seedHolding(userId, {
      buyDate: "2024-01-01",
      quantity: 100_000_000,
      unitPrice: 8000,
      principal: 800_000,
      prices: [{ date: "2024-01-01", close: 8000 }],
    });

    const { getDb } = await import("../db/index.ts");
    const { transactions } = await import("../db/schema.ts");
    const { db } = getDb();
    const unpricedInstrumentId = createInstrument(randomIsin());
    // A second holding bought the same day, in the same account -- but deliberately
    // never given a `prices` row at all, e.g. an S-Pankki/Danske manual fund set to
    // `manual` before its first NAV entry (spec §10a A5).
    getDb()
      .db.insert(transactions)
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

    const body = returnsView(getDb().db, userId, "2024-01-01", "2024-01-05");
    // Superseded twice over. It first reported -1 (-100%) for an otherwise flat,
    // priced position; then null, because a never-priced holding excluded every
    // sub-period. A holding with no price yet is now carried at its cost basis, so
    // nothing is missing, nothing jumps, and a flat window is honestly 0%. The
    // property that has to hold throughout is that no fabricated rate appears.
    expect(body.twr).toBe(0);
    expect(body.excludedInstruments.map((i) => i.instrumentId)).not.toContain(unpricedInstrumentId);
  });

  test("refuses a backwards range", async () => {
    // Kept as a schema test because that is where the rule moved: an empty
    // chart for a typo'd date looks exactly like an empty chart for an empty
    // portfolio, so the refusal has to happen before the query runs.
    expect(Range.safeParse({ from: "2024-06-01", to: "2024-01-01" }).success).toBe(false);
    expect(Range.safeParse({ from: "2024-01-01", to: "2024-06-01" }).success).toBe(true);
  });

  // Defence in depth -- see the matching comment on /api/value-series.
  test("scopes returns to the caller and never counts another user's position", async () => {
    const owner = await signUp(`returns-owner-${crypto.randomUUID()}@example.com`);
    const stranger = await signUp(`returns-stranger-${crypto.randomUUID()}@example.com`);
    await seedHolding(owner.userId, {
      buyDate: "2024-01-01",
      quantity: 10_000_000,
      unitPrice: 1000,
      principal: 10_000,
      prices: [{ date: "2024-01-01", close: 1000 }],
    });

    const body = returnsView(getDb().db, stranger.userId, "2024-01-01", "2024-01-01");
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
    const { userId, cookie } = await signUp(`returns-windowed-${crypto.randomUUID()}@example.com`);
    await seedHolding(userId, {
      buyDate: "2024-01-01",
      quantity: 100_000_000, // 100 units
      unitPrice: 5000, // 50.00/unit
      principal: 500_000, // 5,000.00 -- fully funded, no deposit needed for this test
      prices: [
        { date: "2024-01-01", close: 5000 }, // 50.00/unit -- still the latest price at 2024-06-30
        { date: "2025-01-01", close: 6000 }, // 60.00/unit
      ],
    });

    const body = returnsView(getDb().db, userId, "2024-07-01", "2025-01-01");
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

describe("GET /api/cash", () => {
  // The anonymous-caller test went with the route. Every server function on
  // this screen declares the authed middleware, which resolves a session or
  // redirects -- there is no path into one that skips it.

  test("reports what a deposit left uninvested, and adds it to the portfolio value", async () => {
    const { userId, cookie } = await signUp(`cash-${crypto.randomUUID()}@example.com`);
    const { accountId } = await seedHolding(userId, {
      buyDate: "2024-01-01",
      quantity: 10_000_000,
      unitPrice: 1000,
      principal: 10_000,
      prices: [{ date: "2024-01-01", close: 1000 }],
    });

    const { getDb } = await import("../db/index.ts");
    const { transactions } = await import("../db/schema.ts");
    const { db } = getDb();
    // 500,00 in, 100,00 spent on the holding above: 400,00 left as cash.
    getDb()
      .db.insert(transactions)
      .values([
        {
          accountId,
          instrumentId: null,
          type: "DEPOSIT" as const,
          tradeDate: "2023-12-31",
          quantity: 0,
          unitPrice: null,
          amount: 50_000,
          fee: 0,
          tax: 0,
          currency: EUR,
          fxRateEur: 100_000_000,
          contentHash: crypto.randomUUID(),
        },
      ])
      .run();

    const cashBody = cashView(getDb().db, userId, "2024-01-01");
    expect(cashBody.totalEur).toBe("400.00");
    expect(cashBody.rows[0]?.currency).toBe("EUR");

    const returnsBody = returnsView(getDb().db, userId, "2024-01-01", "2024-01-01");
    // Positions and cash stay separate and are also given added up, so the
    // dashboard never has to do money arithmetic of its own.
    expect(returnsBody.valueEur).toBe("100.00");
    expect(returnsBody.cashEur).toBe("400.00");
    expect(returnsBody.valueWithCashEur).toBe("500.00");
  });

  test("reports no cash for an account whose export never recorded any", async () => {
    const { userId, cookie } = await signUp(`cash-none-${crypto.randomUUID()}@example.com`);
    await seedHolding(userId, {
      buyDate: "2024-01-01",
      quantity: 10_000_000,
      unitPrice: 1000,
      principal: 10_000,
      prices: [{ date: "2024-01-01", close: 1000 }],
    });

    const body = cashView(getDb().db, userId, "2024-01-01");
    // The purchase alone would sum to -100,00, which is an artefact of an
    // export that lists securities only -- not a debt.
    expect(body.rows).toEqual([]);
    expect(body.totalEur).toBe("0.00");
  });
});

describe("bank accounts", () => {
  test("their movements never reach the return figures, but their cash reaches the value", async () => {
    const { userId, cookie } = await signUp(`bank-${crypto.randomUUID()}@example.com`);
    const { accountId } = await seedHolding(userId, {
      buyDate: "2024-01-01",
      quantity: 10_000_000,
      unitPrice: 1000,
      principal: 10_000,
      prices: [
        { date: "2024-01-01", close: 1000 },
        { date: "2024-06-01", close: 1200 },
      ],
    });

    const { getDb } = await import("../db/index.ts");
    const { transactions } = await import("../db/schema.ts");
    const { db } = getDb();
    const cashRow = (
      target: number,
      type: "DEPOSIT" | "WITHDRAWAL",
      tradeDate: string,
      amount: number,
    ) => ({
      accountId: target,
      instrumentId: null,
      type,
      tradeDate,
      quantity: 0,
      unitPrice: null,
      amount,
      fee: 0,
      tax: 0,
      currency: EUR,
      fxRateEur: 100_000_000,
      contentHash: crypto.randomUUID(),
    });

    // The brokerage account funds its own purchase, so there is a real flow.
    getDb()
      .db.insert(transactions)
      .values([cashRow(accountId, "DEPOSIT", "2023-12-31", 10_000)])
      .run();

    const askReturns = () => returnsView(getDb().db, userId, "2024-01-01", "2024-06-01");
    const before = askReturns();

    // A bank account with a salary in and a grocery run out.
    const bankId = openAccountRow(
      getDb().db,
      userId,
      CreateAccount.parse({
        name: "OP käyttötili",
        broker: "op",
        kind: "bank",
        accountType: "current",
      }),
    ).id;
    getDb()
      .db.insert(transactions)
      .values([
        cashRow(bankId, "DEPOSIT", "2024-02-01", 320_000),
        cashRow(bankId, "WITHDRAWAL", "2024-02-02", -4_215),
      ])
      .run();

    const after = askReturns();

    // The whole point: spending is not performance.
    expect(after.twr).toBe(before.twr);
    expect(after.mwr).toBe(before.mwr);
    expect(after.valueEur).toBe(before.valueEur);
    // ...but the money is real and shows up in what the portfolio is worth.
    expect(after.cashEur).toBe("3157.85");
    expect(after.valueWithCashEur).toBe("3277.85");
  });
});

describe("a fixed-term deposit's cash", () => {
  const openDeposit = (userId: string, maturityDate: string | null): number => {
    const account = {
      name: "OP määräaikaistili",
      broker: "op",
      kind: "bank",
      accountType: "fixed_term",
    };
    return openAccountRow(
      getDb().db,
      userId,
      CreateAccount.parse(maturityDate === null ? account : { ...account, maturityDate }),
    ).id;
  };

  const deposit = async (accountId: number, amount: number, tradeDate: string) => {
    const { getDb } = await import("../db/index.ts");
    const { transactions } = await import("../db/schema.ts");
    const { db } = getDb();
    getDb()
      .db.insert(transactions)
      .values([
        {
          accountId,
          instrumentId: null,
          type: "DEPOSIT" as const,
          tradeDate,
          quantity: 0,
          unitPrice: null,
          amount,
          fee: 0,
          tax: 0,
          currency: EUR,
          fxRateEur: 100_000_000,
          contentHash: crypto.randomUUID(),
        },
      ])
      .run();
  };

  test("counts toward the total but not toward what can be spent today", async () => {
    const { userId, cookie } = await signUp(`locked-${crypto.randomUUID()}@example.com`);
    const depositId = openDeposit(userId, "2027-06-22");
    await deposit(depositId, 1_000_000, "2026-06-22");

    const body = cashView(getDb().db, userId, "2026-08-28");

    expect(body.totalEur).toBe("10000.00");
    // The money is the owner's, and none of it is available before maturity.
    expect(body.availableEur).toBe("0.00");
    expect(body.lockedEur).toBe("10000.00");
    expect(body.rows[0]?.locked).toBe(true);
    expect(body.rows[0]?.availableFrom).toBe("2027-06-22");
  });

  test("becomes spendable once the term has run", async () => {
    const { userId, cookie } = await signUp(`matured-${crypto.randomUUID()}@example.com`);
    const depositId = openDeposit(userId, "2027-06-22");
    await deposit(depositId, 1_000_000, "2026-06-22");

    const body = cashView(getDb().db, userId, "2027-07-01");

    expect(body.availableEur).toBe("10000.00");
    expect(body.lockedEur).toBe("0.00");
  });

  test("a deposit with no maturity recorded stays locked rather than counted as spendable", async () => {
    const { userId, cookie } = await signUp(`unknown-term-${crypto.randomUUID()}@example.com`);
    const depositId = openDeposit(userId, null);
    await deposit(depositId, 500_000, "2026-06-22");

    const body = cashView(getDb().db, userId, "2026-08-28");

    // "Nobody entered when this frees up" is not the same as "it is free".
    expect(body.lockedEur).toBe("5000.00");
    expect(body.rows[0]?.availableFrom).toBeNull();
  });

  test("gets its own allocation slice, separate from spendable cash", async () => {
    const { userId, cookie } = await signUp(`slice-${crypto.randomUUID()}@example.com`);
    const currentId = openAccountRow(
      getDb().db,
      userId,
      CreateAccount.parse({
        name: "OP käyttötili",
        broker: "op",
        kind: "bank",
        accountType: "current",
      }),
    ).id;
    const depositId = openDeposit(userId, "2027-06-22");
    await deposit(currentId, 100_000, "2026-06-22");
    await deposit(depositId, 1_000_000, "2026-06-22");

    const body = allocationView(getDb().db, userId, "kind", "2026-08-28");

    expect(body.slices.find((slice) => slice.key === "cash")?.valueEur).toBe("1000.00");
    expect(body.slices.find((slice) => slice.key === "fixed_term")?.valueEur).toBe("10000.00");
  });
});

describe("GET /api/spending/uncategorised", () => {
  const UncategorisedSchema = z.object({
    totalEur: z.string(),
    merchants: z.array(
      z.object({
        name: z.string(),
        totalEur: z.string(),
        count: z.number(),
        payeeKnown: z.boolean(),
      }),
    ),
    categories: z.array(z.object({ id: z.string(), label: z.string() })),
  });

  const bankAccount = (userId: string): number =>
    openAccountRow(
      getDb().db,
      userId,
      CreateAccount.parse({
        name: "OP käyttötili",
        broker: "op",
        kind: "bank",
        accountType: "current",
      }),
    ).id;

  const spend = async (accountId: number, note: string, minor: number, tradeDate: string) => {
    const { getDb } = await import("../db/index.ts");
    const { transactions } = await import("../db/schema.ts");
    getDb()
      .db.insert(transactions)
      .values([
        {
          accountId,
          instrumentId: null,
          type: "WITHDRAWAL" as const,
          tradeDate,
          quantity: 0,
          unitPrice: null,
          amount: minor,
          fee: 0,
          tax: 0,
          currency: EUR,
          fxRateEur: 100_000_000,
          contentHash: crypto.randomUUID(),
          note,
        },
      ])
      .run();
  };

  const ask = (userId: string) => uncategorisedView(getDb().db, userId, "2026-01-01", "2026-12-31");

  // The anonymous-caller case is the middleware's, as above.

  test("GET /api/spending/transactions lists every movement with the class it was given", async () => {
    // The categorised totals are summaries, and a summary nobody can open is
    // one they have to take on trust. This is the ledger behind them.
    const { userId, cookie } = await signUp(`ledger-${crypto.randomUUID()}@example.com`);
    const accountId = bankAccount(userId);
    await spend(accountId, "PKORTTIMAKSU — K-MARKET ESIMERKKI", -4215, "2026-03-01");
    await spend(accountId, "PALKKA — ESIMERKKI OYJ", 300_000, "2026-03-02");

    const response = classifiedView(getDb().db, userId, "2026-01-01", "2026-12-31");
    const body = response;

    // Newest first, each with its class, and money in named as income rather
    // than dropped from the list.
    expect(body.transactions[0]!.text).toContain("PALKKA");
    expect(body.transactions[0]!.excludedReason).toBe("income");
    expect(body.transactions[0]!.counted).toBe(false);
    expect(body.transactions[1]!.categoryLabel).toBe("Ruokakauppa");
    expect(body.transactions[1]!.amountEur).toBe("-42.15");
  });

  // The anonymous-caller case is the middleware's, as above.

  test("lists what no rule matched, summed per payee, and nothing else", async () => {
    const { userId, cookie } = await signUp(`uncat-${crypto.randomUUID()}@example.com`);
    const accountId = bankAccount(userId);
    await spend(accountId, "PKORTTIMAKSU — K-MARKET ESIMERKKI", -4215, "2026-03-01");
    await spend(accountId, "PKORTTIMAKSU — PIENI PUOTI OY", -1000, "2026-03-02");
    await spend(accountId, "PKORTTIMAKSU — PIENI PUOTI OY", -500, "2026-03-03");

    const body = ask(userId);

    // The grocery shop has a seed rule; the unknown one is here, added up.
    expect(body.merchants).toEqual([
      { name: "PIENI PUOTI OY", totalEur: "-15.00", count: 2, payeeKnown: true },
    ]);
    expect(body.totalEur).toBe("-15.00");
    expect(body.categories.length).toBeGreaterThan(10);
  });

  test("a payee disappears from the list once it has a rule", async () => {
    const { userId, cookie } = await signUp(`uncat-rule-${crypto.randomUUID()}@example.com`);
    const accountId = bankAccount(userId);
    await spend(accountId, "PKORTTIMAKSU — PIENI PUOTI OY", -1000, "2026-03-02");
    expect(ask(userId).merchants).toHaveLength(1);

    addRules(getDb().db, userId, [{ pattern: "PIENI PUOTI OY", category: "ruoka" }], "user");

    // Which is the whole loop this screen exists for: see it, file it, gone.
    expect(ask(userId).merchants).toEqual([]);
  });

  test("marks a bare payment label as having no payee, so no rule is offered for it", async () => {
    const { userId, cookie } = await signUp(`uncat-label-${crypto.randomUUID()}@example.com`);
    const accountId = bankAccount(userId);
    // A statement that carried no payee leaves the note as the label alone.
    await spend(accountId, "MAKSUPALVELU", -45_297, "2026-03-01");

    const body = ask(userId);

    // A rule on "MAKSUPALVELU" would file every bill payment as whatever this
    // one turned out to be -- rent, in the case that produced this test.
    expect(body.merchants[0]?.name).toBe("MAKSUPALVELU");
    expect(body.merchants[0]?.payeeKnown).toBe(false);
  });

  test("leaves out a payment that funded an investment", async () => {
    const { userId, cookie } = await signUp(`uncat-inv-${crypto.randomUUID()}@example.com`);
    const accountId = bankAccount(userId);
    const brokerage = createAccount(userId);
    const instrumentId = createInstrument(randomIsin());
    await spend(accountId, "SÄÄNN.SÄÄST. — RAHASTO", -25_000, "2026-03-01");

    const { getDb } = await import("../db/index.ts");
    const { transactions } = await import("../db/schema.ts");
    getDb()
      .db.insert(transactions)
      .values([
        {
          accountId: brokerage,
          instrumentId,
          type: "BUY" as const,
          tradeDate: "2026-03-02",
          quantity: 1_000_000,
          unitPrice: 25_000,
          amount: -25_000,
          fee: 0,
          tax: 0,
          currency: EUR,
          fxRateEur: 100_000_000,
          contentHash: crypto.randomUUID(),
        },
      ])
      .run();

    // Money put into a fund is not an unclassified expense waiting for a label.
    expect(ask(userId).merchants).toEqual([]);
  });
});

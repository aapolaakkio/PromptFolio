import { beforeAll, describe, expect, test } from "vitest";
import { CreateAccount, openAccount as openAccountRow } from "../accounts.ts";
import { addRules } from "../spending/rules.ts";
import { AllocationInput } from "../../web/server/portfolio.ts";
import { Range } from "../../web/server/portfolio.ts";
import { db } from "../db/index.ts";
import { holdingsFor } from "../valuation.ts";
import {
  allocationView,
  cashView,
  classifiedView,
  returnsView,
  uncategorisedView,
  valueSeriesView,
} from "./portfolio.ts";
import { addInstrument } from "../instruments/store.ts";
import { EUR, parseMoney } from "../../core/money.ts";
import { xirr } from "../../core/returns.ts";

// Real migrated DB pinned by test-setup.ts (never reset it here). Shared across files, so ids and ISINs are random.

const today = (): string => new Date().toISOString().slice(0, 10);

let auth: ReturnType<(typeof import("../auth.ts"))["getAuth"]>;

beforeAll(async () => {
  const authModule = await import("../auth.ts");
  auth = authModule.getAuth();
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

/** A valid but never-real ISIN from a fresh UUID. */
const randomIsin = (): string =>
  `XX${crypto.randomUUID().replace(/-/g, "").toUpperCase().slice(0, 9)}0`;

const createAccount = async (userId: string): Promise<number> =>
  (await openAccountRow(db, userId, CreateAccount.parse({ name: "Nordnet", broker: "nordnet" })))
    .id;

const createInstrument = async (isin: string): Promise<number> => {
  return (
    await addInstrument(db, {
      isin,
      ticker: "TST",
      name: "Test Co",
      kind: "stock",
      currency: EUR,
      priceSource: "manual",
      sourceKey: isin,
    })
  ).id;
};

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
  const { db } = await import("../db/index.ts");
  const { prices, transactions } = await import("../db/schema.ts");

  const accountId = await createAccount(userId);
  const instrumentId = await createInstrument(randomIsin());
  const fee = opts.fee ?? 0;

  await db
    .insert(transactions)
    .values({
      accountId,
      instrumentId,
      type: "BUY",
      tradeDate: opts.buyDate,
      quantity: opts.quantity,
      unitPrice: opts.unitPrice,
      // `amount` is the fee-inclusive cash total, as brokers report it.
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
    await db
      .insert(prices)
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

// --- GET /api/holdings ---

describe("GET /api/holdings", () => {
  test("returns quantity, cost, value and gain as decimal strings, and flags staleness", async () => {
    const { userId } = await signUp(`holdings-${crypto.randomUUID()}@example.com`);
    await seedHolding(userId, {
      buyDate: "2024-01-10",
      quantity: 100_000_000,
      unitPrice: 415,
      principal: 41_500,
      fee: 300,
      prices: [{ date: "2024-01-10", close: 415 }],
    });

    const body = await holdingsFor(db, userId, "2024-06-01");
    expect(body).toHaveLength(1);
    const holding = body[0]!;
    expect(holding.quantity).toBe("100.000000");
    expect(holding.costEur).toBe("418.00");
    expect(holding.valueEur).toBe("415.00");
    expect(holding.unrealisedEur).toBe("-3.00");
    expect(holding.priceDate).toBe("2024-01-10");
    // Priced on 10.1. but requested as of 1.6. -- carried forward, so stale.
    expect(holding.stale).toBe(true);
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

    // The id comes from the session: a stranger sees their own empty portfolio.
    expect(await holdingsFor(db, stranger.userId, today())).toEqual([]);
  });

  // Regression: a SELL imported before its BUY degrades only that position (marked with ISIN, name, date and a what-to-do message), not the whole screen.
  test("degrades the affected position instead of 400ing the whole request when a sale has no matching purchase", async () => {
    const { userId } = await signUp(`holdings-unmatched-${crypto.randomUUID()}@example.com`);
    const { db } = await import("../db/index.ts");
    const { transactions } = await import("../db/schema.ts");

    const accountId = await createAccount(userId);
    const isin = randomIsin();
    const instrumentId = await createInstrument(isin);

    await db
      .insert(transactions)
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

    const body = await holdingsFor(db, userId, "2025-01-01");
    expect(body).toHaveLength(1);
    const holding = body[0]!;
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
    expect(message).toMatch(/import|delete/i);
    // No internal detail leaked (core's raw error names the numeric instrument id).
    expect(message).not.toMatch(/cannot dispose/i);
    expect(message).not.toMatch(/instrument \d/i);
  });

  test("an unmatched sale on one instrument does not affect another instrument's holding", async () => {
    const { userId } = await signUp(`holdings-unmatched-other-${crypto.randomUUID()}@example.com`);
    const { db } = await import("../db/index.ts");
    const { transactions } = await import("../db/schema.ts");

    const { accountId } = await seedHolding(userId, {
      buyDate: "2024-01-10",
      quantity: 10_000_000,
      unitPrice: 100,
      principal: 1_000,
      prices: [{ date: "2024-01-10", close: 100 }],
    });

    const brokenIsin = randomIsin();
    const brokenInstrumentId = await createInstrument(brokenIsin);
    await db
      .insert(transactions)
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

    const body = await holdingsFor(db, userId, "2024-06-01");
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
    const { userId } = await signUp(`series-${crypto.randomUUID()}@example.com`);
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

    const body = await valueSeriesView(db, userId, "2024-01-01", "2024-01-05");
    expect(body).toHaveLength(5);
    expect(body[0]).toEqual({
      date: "2024-01-01",
      valueEur: "100.00",
      investedEur: "100.00",
      stale: false,
      costValued: false,
      cashEur: "0.00",
      excludedInstrumentIds: [],
    });
    expect(body.at(-1)).toEqual({
      date: "2024-01-05",
      valueEur: "110.00",
      investedEur: "100.00",
      stale: false,
      costValued: false,
      cashEur: "0.00",
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

    const body = await valueSeriesView(db, userId, undefined, "2024-01-03");
    expect(body[0]?.date).toBe("2024-01-01");
    expect(body).toHaveLength(3);
  });

  test("defaults to a long since-inception range without error", async () => {
    const { userId } = await signUp(`series-default-${crypto.randomUUID()}@example.com`);
    const body = await valueSeriesView(db, userId, "2015-01-01", today());
    expect(body[0]!.date).toBe("2015-01-01");
    expect(body.length).toBeGreaterThan(2000);
    expect(body.every((p) => p.valueEur === "0.00")).toBe(true);
  });

  test("refuses a backwards range", async () => {
    // Schema test: an empty chart for a typo'd date looks like an empty portfolio, so refuse before querying.
    expect(Range.safeParse({ from: "2024-06-01", to: "2024-01-01" }).success).toBe(false);
    expect(Range.safeParse({ from: "2024-01-01", to: "2024-06-01" }).success).toBe(true);
  });

  test("refuses a date that is not one", () => {
    expect(Range.safeParse({ from: "01-01-2024" }).success).toBe(false);
  });

  // Scoping is proven in loadPortfolio(); one direct check per route too.
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

    const body = await valueSeriesView(db, stranger.userId, "2024-01-01", "2024-01-01");
    expect(body).toEqual([
      {
        date: "2024-01-01",
        valueEur: "0.00",
        investedEur: "0.00",
        stale: false,
        costValued: false,
        cashEur: "0.00",
        excludedInstrumentIds: [],
      },
    ]);
  });

  // Regression: an unmatched SELL (negative quantity) must not be priced into a negative value; it is named in excludedInstrumentIds.
  test("a negative (unmatched-disposal) position never makes the daily value negative", async () => {
    const { userId } = await signUp(`series-negative-${crypto.randomUUID()}@example.com`);
    const { db } = await import("../db/index.ts");
    const { transactions } = await import("../db/schema.ts");

    const accountId = await createAccount(userId);
    const instrumentId = await createInstrument(randomIsin());

    await db
      .insert(transactions)
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

    const body = await valueSeriesView(db, userId, "2024-01-01", "2024-01-01");
    expect(body).toHaveLength(1);
    expect(body[0]!.valueEur).toBe("0.00");
    expect(Number(body[0]!.valueEur)).toBeGreaterThanOrEqual(0);
    expect(body[0]!.excludedInstrumentIds).toEqual([instrumentId]);
  });
});

// --- GET /api/allocation ---

describe("GET /api/allocation", () => {
  test("defaults to allocation by kind and reports weight as a ratio", async () => {
    const { userId } = await signUp(`alloc-${crypto.randomUUID()}@example.com`);
    await seedHolding(userId, {
      buyDate: "2024-01-01",
      quantity: 10_000_000,
      unitPrice: 1000,
      principal: 10_000,
      prices: [{ date: "2024-01-01", close: 1000 }],
    });

    const body = await allocationView(db, userId, "kind", "2024-01-01");
    expect(body.slices).toEqual([{ key: "stock", label: "Shares", valueEur: "100.00", weight: 1 }]);
    expect(body.excludedInstruments).toEqual([]);
  });

  test("accepts by=currency", async () => {
    const { userId } = await signUp(`alloc-currency-${crypto.randomUUID()}@example.com`);
    await seedHolding(userId, {
      buyDate: "2024-01-01",
      quantity: 10_000_000,
      unitPrice: 1000,
      principal: 10_000,
      prices: [{ date: "2024-01-01", close: 1000 }],
    });

    const body = await allocationView(db, userId, "currency", "2024-01-01");
    expect(body.slices.map((s) => s.key)).toContain("EUR");
  });

  // Regression: an unmatched SELL must not add a negative amount to a slice, nor vanish from the response.
  test("a negative (unmatched-disposal) position never contributes a negative amount, and is named in excludedInstruments instead", async () => {
    const { userId } = await signUp(`alloc-negative-${crypto.randomUUID()}@example.com`);
    const { db } = await import("../db/index.ts");
    const { transactions } = await import("../db/schema.ts");

    await seedHolding(userId, {
      buyDate: "2024-01-01",
      quantity: 10_000_000,
      unitPrice: 1000,
      principal: 10_000,
      prices: [{ date: "2024-01-01", close: 1000 }],
    });

    const cookieAccountId = await createAccount(userId);
    const brokenIsin = randomIsin();
    const brokenInstrumentId = await createInstrument(brokenIsin);
    await db
      .insert(transactions)
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

    const body = await allocationView(db, userId, "kind", "2024-01-01");
    expect(body.slices).toEqual([{ key: "stock", label: "Shares", valueEur: "100.00", weight: 1 }]);
    expect(body.slices.every((s) => Number(s.valueEur) >= 0)).toBe(true);
    expect(body.excludedInstruments).toEqual([
      { instrumentId: brokenInstrumentId, isin: brokenIsin, name: "Test Co" },
    ]);
  });

  test("refuses a grouping that is not one", () => {
    expect(AllocationInput.safeParse({ by: "sector" }).success).toBe(false);
    expect(AllocationInput.safeParse({ by: "currency" }).success).toBe(true);
  });

  // Defence in depth: see /api/value-series.
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

    const response = await allocationView(db, stranger.userId, "kind", "2024-01-01");
    expect(response).toEqual({ slices: [], excludedInstruments: [] });
  });
});

// --- GET /api/returns ---

describe("GET /api/returns", () => {
  test("reports value, TWR (a ratio) and MWR as a number, given a deposit, a withdrawal and growth", async () => {
    const { userId } = await signUp(`returns-${crypto.randomUUID()}@example.com`);
    const { db } = await import("../db/index.ts");
    const { transactions } = await import("../db/schema.ts");

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

    await db
      .insert(transactions)
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

    const body = await returnsView(db, userId, "2024-01-01", "2025-01-01");
    expect(body.valueEur).toBe("10000.00");
    expect(body.stale).toBe(false);
    // 100 units bought at 80.00, priced 100.00 a year later: one sub-period, 10000/8000 - 1 = 0.25. The deposit and withdrawal never touch a position, so twr excludes them.
    expect(body.twr).toBeCloseTo(0.25, 9);
    // Regression: negating a withdrawal's negative amount used to give an unparsable "--100.00" and a null MWR.
    expect(body.mwr).not.toBeNull();
    // `?? NaN` only narrows the type; a null mwr still fails.
    expect(Number.isFinite(body.mwr ?? Number.NaN)).toBe(true);
  });

  test("returns mwr: null (not a fabricated rate) when contributions have no offsetting sign", async () => {
    const { userId } = await signUp(`returns-nullmwr-${crypto.randomUUID()}@example.com`);
    const { db } = await import("../db/index.ts");
    const { transactions } = await import("../db/schema.ts");

    const accountId = await createAccount(userId);

    // A never-invested deposit leaves tracked value at 0: xirr is "unknown", not "0%".
    await db
      .insert(transactions)
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

    const body = await returnsView(db, userId, "2024-01-01", "2024-12-31");
    expect(body.valueEur).toBe("0.00");
    expect(body.mwr).toBeNull();
  });

  test("returns mwr: null rather than throwing for a user with no transactions at all", async () => {
    const { userId } = await signUp(`returns-empty-${crypto.randomUUID()}@example.com`);
    const body = await returnsView(db, userId, "2024-01-01", "2024-12-31");
    expect(body.mwr).toBeNull();
    expect(body.twr).toBe(0);
    expect(body.valueEur).toBe("0.00");
  });

  // An unvaluable holding must never collapse `twr` to a fabricated rate.
  test("reports twr: null and names the holding in excludedInstruments when a second instrument has no price at all", async () => {
    const { userId } = await signUp(`returns-excluded-${crypto.randomUUID()}@example.com`);
    const { accountId } = await seedHolding(userId, {
      buyDate: "2024-01-01",
      quantity: 100_000_000,
      unitPrice: 8000,
      principal: 800_000,
      prices: [{ date: "2024-01-01", close: 8000 }],
    });

    const { db } = await import("../db/index.ts");
    const { transactions } = await import("../db/schema.ts");

    const unpricedInstrumentId = await createInstrument(randomIsin());
    // A second holding bought the same day with no `prices` row (e.g. a manual fund before its first NAV).
    await db
      .insert(transactions)
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

    const body = await returnsView(db, userId, "2024-01-01", "2024-01-05");
    // A never-priced holding is carried at cost, so a flat window is honestly 0%.
    expect(body.twr).toBe(0);
    expect(body.excludedInstruments.map((i) => i.instrumentId)).not.toContain(unpricedInstrumentId);
  });

  test("refuses a backwards range", async () => {
    // Schema test: an empty chart for a typo'd date looks like an empty portfolio, so refuse before querying.
    expect(Range.safeParse({ from: "2024-06-01", to: "2024-01-01" }).success).toBe(false);
    expect(Range.safeParse({ from: "2024-01-01", to: "2024-06-01" }).success).toBe(true);
  });

  // Defence in depth: see /api/value-series.
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

    const body = await returnsView(db, stranger.userId, "2024-01-01", "2024-01-01");
    expect(body.valueEur).toBe("0.00");
    expect(body.mwr).toBeNull();
  });

  // Regression: with `from` after inception, the value already held going into `from` must be an opening flow. Pin the number, not just non-null.
  test("MWR over a window starting after inception accounts for the value already there", async () => {
    const { userId } = await signUp(`returns-windowed-${crypto.randomUUID()}@example.com`);
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

    const body = await returnsView(db, userId, "2024-07-01", "2025-01-01");
    expect(body.valueEur).toBe("6000.00"); // 100 x 60.00

    // Expected flows derived independently: -5000.00 held on 2024-07-01, +6000.00 on 2025-01-01, no deposits. Checks portfolio.ts assembles the right flows, not xirr's math.
    const expected = xirr([{ date: "2024-07-01", amountEur: parseMoney("-5000.00", EUR) }], {
      date: "2025-01-01",
      amountEur: parseMoney("6000.00", EUR),
    });
    expect(body.mwr).not.toBeNull();
    expect(body.mwr).toBeCloseTo(expected, 9);
    // Sanity bound: 20% growth over half a year is substantial double-digit annualised.
    expect(body.mwr ?? Number.NaN).toBeGreaterThan(0.3);
  });
});

describe("GET /api/cash", () => {
  test("reports what a deposit left uninvested, and adds it to the portfolio value", async () => {
    const { userId } = await signUp(`cash-${crypto.randomUUID()}@example.com`);
    const { accountId } = await seedHolding(userId, {
      buyDate: "2024-01-01",
      quantity: 10_000_000,
      unitPrice: 1000,
      principal: 10_000,
      prices: [{ date: "2024-01-01", close: 1000 }],
    });

    const { db } = await import("../db/index.ts");
    const { transactions } = await import("../db/schema.ts");

    await db
      .insert(transactions)
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

    const cashBody = await cashView(db, userId, "2024-01-01");
    expect(cashBody.totalEur).toBe("400.00");
    expect(cashBody.rows[0]?.currency).toBe("EUR");

    const returnsBody = await returnsView(db, userId, "2024-01-01", "2024-01-01");
    expect(returnsBody.valueEur).toBe("100.00");
    expect(returnsBody.cashEur).toBe("400.00");
    expect(returnsBody.valueWithCashEur).toBe("500.00");
  });

  test("reports no cash for an account whose export never recorded any", async () => {
    const { userId } = await signUp(`cash-none-${crypto.randomUUID()}@example.com`);
    await seedHolding(userId, {
      buyDate: "2024-01-01",
      quantity: 10_000_000,
      unitPrice: 1000,
      principal: 10_000,
      prices: [{ date: "2024-01-01", close: 1000 }],
    });

    const body = await cashView(db, userId, "2024-01-01");
    // The purchase alone sums to -100.00: an artefact of a securities-only export, not a debt.
    expect(body.rows).toEqual([]);
    expect(body.totalEur).toBe("0.00");
  });
});

describe("bank accounts", () => {
  test("their movements never reach the return figures, but their cash reaches the value", async () => {
    const { userId } = await signUp(`bank-${crypto.randomUUID()}@example.com`);
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

    const { db } = await import("../db/index.ts");
    const { transactions } = await import("../db/schema.ts");

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

    await db
      .insert(transactions)
      .values([cashRow(accountId, "DEPOSIT", "2023-12-31", 10_000)])
      .run();

    const askReturns = () => returnsView(db, userId, "2024-01-01", "2024-06-01");
    const before = await askReturns();

    const bankId = (
      await openAccountRow(
        db,
        userId,
        CreateAccount.parse({
          name: "OP current account",
          broker: "op",
          kind: "bank",
          accountType: "current",
        }),
      )
    ).id;
    await db
      .insert(transactions)
      .values([
        cashRow(bankId, "DEPOSIT", "2024-02-01", 320_000),
        cashRow(bankId, "WITHDRAWAL", "2024-02-02", -4_215),
      ])
      .run();

    const after = await askReturns();

    // The whole point: spending is not performance.
    expect(after.twr).toBe(before.twr);
    expect(after.mwr).toBe(before.mwr);
    expect(after.valueEur).toBe(before.valueEur);
    expect(after.cashEur).toBe("3157.85");
    expect(after.valueWithCashEur).toBe("3277.85");
  });
});

describe("a fixed-term deposit's cash", () => {
  const openDeposit = async (userId: string, maturityDate: string | null): Promise<number> => {
    const account = {
      name: "OP fixed-term account",
      broker: "op",
      kind: "bank",
      accountType: "fixed_term",
    };
    return (
      await openAccountRow(
        db,
        userId,
        CreateAccount.parse(maturityDate === null ? account : { ...account, maturityDate }),
      )
    ).id;
  };

  const deposit = async (accountId: number, amount: number, tradeDate: string) => {
    const { db } = await import("../db/index.ts");
    const { transactions } = await import("../db/schema.ts");

    await db
      .insert(transactions)
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
    const { userId } = await signUp(`locked-${crypto.randomUUID()}@example.com`);
    const depositId = await openDeposit(userId, "2027-06-22");
    await deposit(depositId, 1_000_000, "2026-06-22");

    const body = await cashView(db, userId, "2026-08-28");

    expect(body.totalEur).toBe("10000.00");
    // The money is the owner's, and none of it is available before maturity.
    expect(body.availableEur).toBe("0.00");
    expect(body.lockedEur).toBe("10000.00");
    expect(body.rows[0]?.locked).toBe(true);
    expect(body.rows[0]?.availableFrom).toBe("2027-06-22");
  });

  test("becomes spendable once the term has run", async () => {
    const { userId } = await signUp(`matured-${crypto.randomUUID()}@example.com`);
    const depositId = await openDeposit(userId, "2027-06-22");
    await deposit(depositId, 1_000_000, "2026-06-22");

    const body = await cashView(db, userId, "2027-07-01");

    expect(body.availableEur).toBe("10000.00");
    expect(body.lockedEur).toBe("0.00");
  });

  test("a deposit with no maturity recorded stays locked rather than counted as spendable", async () => {
    const { userId } = await signUp(`unknown-term-${crypto.randomUUID()}@example.com`);
    const depositId = await openDeposit(userId, null);
    await deposit(depositId, 500_000, "2026-06-22");

    const body = await cashView(db, userId, "2026-08-28");

    // "Nobody entered when this frees up" is not the same as "it is free".
    expect(body.lockedEur).toBe("5000.00");
    expect(body.rows[0]?.availableFrom).toBeNull();
  });

  test("gets its own allocation slice, separate from spendable cash", async () => {
    const { userId } = await signUp(`slice-${crypto.randomUUID()}@example.com`);
    const currentId = (
      await openAccountRow(
        db,
        userId,
        CreateAccount.parse({
          name: "OP current account",
          broker: "op",
          kind: "bank",
          accountType: "current",
        }),
      )
    ).id;
    const depositId = await openDeposit(userId, "2027-06-22");
    await deposit(currentId, 100_000, "2026-06-22");
    await deposit(depositId, 1_000_000, "2026-06-22");

    const body = await allocationView(db, userId, "kind", "2026-08-28");

    expect(body.slices.find((slice) => slice.key === "cash")?.valueEur).toBe("1000.00");
    expect(body.slices.find((slice) => slice.key === "fixed_term")?.valueEur).toBe("10000.00");
  });
});

describe("GET /api/spending/uncategorised", () => {
  const bankAccount = async (userId: string): Promise<number> =>
    (
      await openAccountRow(
        db,
        userId,
        CreateAccount.parse({
          name: "OP current account",
          broker: "op",
          kind: "bank",
          accountType: "current",
        }),
      )
    ).id;

  const spend = async (accountId: number, note: string, minor: number, tradeDate: string) => {
    const { db } = await import("../db/index.ts");
    const { transactions } = await import("../db/schema.ts");
    await db
      .insert(transactions)
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

  const ask = (userId: string) => uncategorisedView(db, userId, "2026-01-01", "2026-12-31");

  test("GET /api/spending/transactions lists every movement with the class it was given", async () => {
    const { userId } = await signUp(`ledger-${crypto.randomUUID()}@example.com`);
    const accountId = await bankAccount(userId);
    await spend(accountId, "PKORTTIMAKSU — K-MARKET EXAMPLE", -4215, "2026-03-01");
    await spend(accountId, "PALKKA — EXAMPLE OYJ", 300_000, "2026-03-02");

    const response = await classifiedView(db, userId, "2026-01-01", "2026-12-31");
    const body = response;

    expect(body.transactions[0]!.text).toContain("PALKKA");
    expect(body.transactions[0]!.excludedReason).toBe("income");
    expect(body.transactions[0]!.counted).toBe(false);
    expect(body.transactions[1]!.categoryLabel).toBe("Groceries");
    expect(body.transactions[1]!.amountEur).toBe("-42.15");
  });

  test("lists what no rule matched, summed per payee, and nothing else", async () => {
    const { userId } = await signUp(`uncat-${crypto.randomUUID()}@example.com`);
    const accountId = await bankAccount(userId);
    await spend(accountId, "PKORTTIMAKSU — K-MARKET EXAMPLE", -4215, "2026-03-01");
    await spend(accountId, "PKORTTIMAKSU — PIENI PUOTI OY", -1000, "2026-03-02");
    await spend(accountId, "PKORTTIMAKSU — PIENI PUOTI OY", -500, "2026-03-03");

    const body = await ask(userId);

    expect(body.merchants).toEqual([
      { name: "PIENI PUOTI OY", totalEur: "-15.00", count: 2, payeeKnown: true },
    ]);
    expect(body.totalEur).toBe("-15.00");
    expect(body.categories.length).toBeGreaterThan(10);
  });

  test("a payee disappears from the list once it has a rule", async () => {
    const { userId } = await signUp(`uncat-rule-${crypto.randomUUID()}@example.com`);
    const accountId = await bankAccount(userId);
    await spend(accountId, "PKORTTIMAKSU — PIENI PUOTI OY", -1000, "2026-03-02");
    expect((await ask(userId)).merchants).toHaveLength(1);

    await addRules(db, userId, [{ pattern: "PIENI PUOTI OY", category: "groceries" }], "user");

    expect((await ask(userId)).merchants).toEqual([]);
  });

  test("marks a bare payment label as having no payee, so no rule is offered for it", async () => {
    const { userId } = await signUp(`uncat-label-${crypto.randomUUID()}@example.com`);
    const accountId = await bankAccount(userId);
    await spend(accountId, "MAKSUPALVELU", -45_297, "2026-03-01");

    const body = await ask(userId);

    // A rule on "MAKSUPALVELU" would file every bill payment under one category.
    expect(body.merchants[0]?.name).toBe("MAKSUPALVELU");
    expect(body.merchants[0]?.payeeKnown).toBe(false);
  });

  test("leaves out a payment that funded an investment", async () => {
    const { userId } = await signUp(`uncat-inv-${crypto.randomUUID()}@example.com`);
    const accountId = await bankAccount(userId);
    const brokerage = await createAccount(userId);
    const instrumentId = await createInstrument(randomIsin());
    await spend(accountId, "SÄÄNN.SÄÄST. — RAHASTO", -25_000, "2026-03-01");

    const { db } = await import("../db/index.ts");
    const { transactions } = await import("../db/schema.ts");
    await db
      .insert(transactions)
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
    expect((await ask(userId)).merchants).toEqual([]);
  });
});

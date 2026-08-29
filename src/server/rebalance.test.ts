import { beforeAll, describe, expect, test } from "bun:test";

import { EUR } from "../core/money";

// Covers what the routes do not reach: attributing a slice-level sale to the
// instruments inside it, and the gain that sale would realise. Same setup rules
// as every other server test -- the shared getDb() handle is already pinned to a
// migrated in-memory database by ./test-setup.ts.

let auth: (typeof import("./auth"))["auth"];
let rebalancePlanFor: (typeof import("./rebalance"))["rebalancePlanFor"];
let saveTargets: (typeof import("./rebalance"))["saveTargets"];

beforeAll(async () => {
  auth = (await import("./auth")).auth;
  rebalancePlanFor = (await import("./rebalance")).rebalancePlanFor;
  saveTargets = (await import("./rebalance")).saveTargets;
});

const signUp = async (): Promise<string> => {
  const response = await auth.handler(
    new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Test User",
        email: `rebalance-server-${crypto.randomUUID()}@example.com`,
        password: "correct horse battery staple",
      }),
    }),
  );
  if (response.status !== 200) throw new Error(`sign-up failed with status ${response.status}`);
  // SAFETY: a 200 from POST /sign-up/email always carries `{ user: { id } }`.
  const body = (await response.json()) as { user: { id: string } };
  return body.user.id;
};

/**
 * Two shares and one fund, priced so the shares are worth twice their cost and
 * the fund exactly its cost. Targets put half in each, so the plan must sell
 * shares and buy fund.
 */
const seed = async (o: { costKnown: boolean }): Promise<string> => {
  const { getDb } = await import("./db");
  const { accounts, instruments, prices, transactions } = await import("./db/schema");
  const { db } = getDb();
  const userId = await signUp();

  const accountId = db
    .insert(accounts)
    .values({ userId, name: "Nordnet", broker: "nordnet", accountType: "aot", kind: "brokerage" })
    .returning({ id: accounts.id })
    .all()[0]!.id;

  const makeInstrument = (name: string, kind: "stock" | "fund") => {
    const isin = `XX${crypto.randomUUID().replace(/-/g, "").toUpperCase().slice(0, 9)}0`;
    return db
      .insert(instruments)
      .values({
        isin,
        ticker: null,
        name,
        kind,
        currency: EUR,
        priceSource: "manual",
        sourceKey: isin,
      })
      .returning({ id: instruments.id })
      .all()[0]!.id;
  };

  const big = makeInstrument("Big Co", "stock");
  const small = makeInstrument("Small Co", "stock");
  const fund = makeInstrument("A Fund", "fund");

  const buy = (instrumentId: number, amount: number, quantity: number) => ({
    accountId,
    instrumentId,
    type: "BUY" as const,
    tradeDate: "2025-01-10",
    quantity,
    unitPrice: null,
    amount: -amount,
    fee: 0,
    tax: 0,
    currency: EUR,
    fxRateEur: 100_000_000,
    contentHash: crypto.randomUUID(),
    externalId: null,
    importId: null,
  });

  // Big Co cost 300, Small Co cost 100, the fund cost 200.
  db.insert(transactions)
    .values([
      buy(big, 300_00, 10_000_000),
      buy(small, 100_00, 10_000_000),
      buy(fund, 200_00, 10_000_000),
    ])
    .run();

  if (!o.costKnown) {
    // A sale with no matching purchase leaves Big Co's cost basis unknown.
    db.insert(transactions)
      .values({
        ...buy(big, 0, 0),
        type: "SELL",
        tradeDate: "2025-01-05",
        quantity: 5_000_000,
        amount: 50_00,
      })
      .run();
  }

  const price = (instrumentId: number, close: number) => ({
    instrumentId,
    date: "2025-06-02",
    close,
    currency: EUR,
    source: "manual",
    fetchedAt: new Date("2025-06-02T00:00:00Z"),
  });
  // Shares doubled; the fund is flat.
  db.insert(prices)
    .values([price(big, 60_00), price(small, 20_00), price(fund, 20_00)])
    .run();

  saveTargets(db, userId, "kind", [
    { key: "stock", weightBp: 5000 },
    { key: "fund", weightBp: 5000 },
  ]);
  return userId;
};

describe("rebalancePlanFor", () => {
  test("attributes a slice-level sale across the slice's holdings and totals the gain", async () => {
    const userId = await seed({ costKnown: true });
    const { getDb } = await import("./db");

    const plan = rebalancePlanFor(getDb().db, userId, "kind", "2025-06-02");
    const sale = plan.trades.find((trade) => trade.side === "sell");

    // Shares are worth 800 of a 1 000 portfolio against a 50 % target, so 300
    // must come out. Taken largest-first that is all from Big Co, which cost
    // 300 and is worth 600: half of it, realising half its 300 gain.
    expect(sale?.key).toBe("stock");
    expect(sale?.amountEur).toBe("300.00");
    expect(sale?.realisedGainEur).toBe("150.00");
    expect(plan.totalRealisedGainEur).toBe("150.00");
    expect(plan.balanced).toBe(true);
  });

  test("says the gain is unknown when a holding's cost basis is", async () => {
    const userId = await seed({ costKnown: false });
    const { getDb } = await import("./db");

    const plan = rebalancePlanFor(getDb().db, userId, "kind", "2025-06-02");
    const sale = plan.trades.find((trade) => trade.side === "sell");

    // A partial total presented as a whole one is exactly the error this view
    // exists to avoid.
    expect(sale?.gainUnknown).toBe(true);
    expect(sale?.realisedGainEur).toBeNull();
    expect(plan.gainIncomplete).toBe(true);
  });
});

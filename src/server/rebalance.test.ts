import { beforeAll, describe, expect, test } from "vitest";

import { EUR } from "../core/money.ts";

// Covers what the routes do not reach: attributing a slice-level sale to its instruments, and the gain it would realise.

let auth: ReturnType<(typeof import("./auth.ts"))["getAuth"]>;
let rebalancePlanFor: (typeof import("./rebalance.ts"))["rebalancePlanFor"];
let saveTargets: (typeof import("./rebalance.ts"))["saveTargets"];

beforeAll(async () => {
  auth = (await import("./auth.ts")).getAuth();
  rebalancePlanFor = (await import("./rebalance.ts")).rebalancePlanFor;
  saveTargets = (await import("./rebalance.ts")).saveTargets;
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

/** Two shares and one fund: shares worth twice cost, the fund exactly cost. Half-and-half targets, so the plan sells shares and buys fund. */
const seed = async (o: { costKnown: boolean }): Promise<string> => {
  const { db } = await import("./db/index.ts");
  const { accounts, instruments, prices, transactions } = await import("./db/schema.ts");
  const userId = await signUp();

  const accountId = (
    await db
      .insert(accounts)
      .values({ userId, name: "Nordnet", broker: "nordnet", accountType: "aot", kind: "brokerage" })
      .returning({ id: accounts.id })
      .all()
  )[0]!.id;

  const makeInstrument = async (name: string, kind: "stock" | "fund") => {
    const isin = `XX${crypto.randomUUID().replace(/-/g, "").toUpperCase().slice(0, 9)}0`;
    return (
      await db
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
        .all()
    )[0]!.id;
  };

  const big = await makeInstrument("Big Co", "stock");
  const small = await makeInstrument("Small Co", "stock");
  const fund = await makeInstrument("A Fund", "fund");

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
  await db
    .insert(transactions)
    .values([
      buy(big, 300_00, 10_000_000),
      buy(small, 100_00, 10_000_000),
      buy(fund, 200_00, 10_000_000),
    ])
    .run();

  if (!o.costKnown) {
    // A sale with no matching purchase leaves Big Co's cost basis unknown.
    await db
      .insert(transactions)
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
  await db
    .insert(prices)
    .values([price(big, 60_00), price(small, 20_00), price(fund, 20_00)])
    .run();

  await saveTargets(db, userId, "kind", [
    { key: "stock", weightBp: 5000 },
    { key: "fund", weightBp: 5000 },
  ]);
  return userId;
};

describe("rebalancePlanFor", () => {
  test("attributes a slice-level sale across the slice's holdings and totals the gain", async () => {
    const userId = await seed({ costKnown: true });
    const { db } = await import("./db/index.ts");

    const plan = await rebalancePlanFor(db, userId, "kind", "2025-06-02");
    const sale = plan.trades.find((trade) => trade.side === "sell");

    // Shares are 800 of 1 000 against a 50 % target, so 300 comes out, all from Big Co (cost 300, worth 600): half of it, realising half its 300 gain.
    expect(sale?.key).toBe("stock");
    expect(sale?.amountEur).toBe("300.00");
    expect(sale?.realisedGainEur).toBe("150.00");
    expect(plan.totalRealisedGainEur).toBe("150.00");
    expect(plan.balanced).toBe(true);
  });

  test("says the gain is unknown when a holding's cost basis is", async () => {
    const userId = await seed({ costKnown: false });
    const { db } = await import("./db/index.ts");

    const plan = await rebalancePlanFor(db, userId, "kind", "2025-06-02");
    const sale = plan.trades.find((trade) => trade.side === "sell");

    // A partial total shown as a whole one is the error this view avoids.
    expect(sale?.gainUnknown).toBe(true);
    expect(sale?.realisedGainEur).toBeNull();
    expect(plan.gainIncomplete).toBe(true);
  });
});

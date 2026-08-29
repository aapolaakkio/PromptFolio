import { beforeAll, describe, expect, test } from "bun:test";
import { z } from "zod";

import { EUR } from "../../core/money";

// Exercises rebalanceRoutes against a real migrated database and a real Better
// Auth session, following portfolio.test.ts's setup: the shared getDb() handle
// is already pinned to a migrated in-memory database by ../test-setup.ts, so
// this file must not call resetDbHandleForTests() or migrate() itself. Every
// identity is derived from a fresh crypto.randomUUID(), because the database is
// shared with every other test file in the process.

let auth: (typeof import("../auth"))["auth"];
let accountRoutes: (typeof import("./accounts"))["accountRoutes"];
let instrumentRoutes: (typeof import("./instruments"))["instrumentRoutes"];
let rebalanceRoutes: (typeof import("./rebalance"))["rebalanceRoutes"];

beforeAll(async () => {
  auth = (await import("../auth")).auth;
  accountRoutes = (await import("./accounts")).accountRoutes;
  instrumentRoutes = (await import("./instruments")).instrumentRoutes;
  rebalanceRoutes = (await import("./rebalance")).rebalanceRoutes;
});

const sessionCookieFrom = (response: Response): string => {
  const setCookie = response.headers.getSetCookie().find((c) => c.includes("session_token"));
  if (!setCookie) throw new Error("Response carried no session_token cookie");
  const nameValue = setCookie.split(";")[0];
  if (!nameValue) throw new Error("Malformed Set-Cookie header");
  return nameValue;
};

const signUp = async (): Promise<string> => {
  const response = await auth.handler(
    new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Test User",
        email: `rebalance-${crypto.randomUUID()}@example.com`,
        password: "correct horse battery staple",
      }),
    }),
  );
  if (response.status !== 200) throw new Error(`sign-up failed with status ${response.status}`);
  return sessionCookieFrom(response);
};

/** What the route accepts, so the helper does not take an unparsed `unknown`. */
type TargetsBody = {
  readonly dimension: "kind" | "currency" | "account" | "instrument";
  readonly targets: readonly { readonly key: string; readonly weightPercent: string }[];
};

const putTargets = (cookie: string, body: TargetsBody) =>
  rebalanceRoutes["/api/targets"].PUT(
    new Request("http://x/api/targets", {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(body),
    }),
  );

const TargetsSchema = z.array(z.object({ key: z.string(), weightPercent: z.string() }));

describe("PUT /api/targets", () => {
  test("refuses a set that does not sum to 100 %, naming the total", async () => {
    const cookie = await signUp();
    const response = await putTargets(cookie, {
      dimension: "kind",
      targets: [
        { key: "stock", weightPercent: "60" },
        { key: "fund", weightPercent: "30" },
      ],
    });

    expect(response.status).toBe(400);
    // The owner sees what it sums to, not merely that it is wrong.
    expect(await response.text()).toContain("90");
  });

  test("replaces a previous set wholesale rather than adding to it", async () => {
    const cookie = await signUp();
    await putTargets(cookie, {
      dimension: "kind",
      targets: [
        { key: "stock", weightPercent: "60" },
        { key: "fund", weightPercent: "40" },
      ],
    });
    await putTargets(cookie, {
      dimension: "kind",
      targets: [
        { key: "stock", weightPercent: "50" },
        { key: "etf", weightPercent: "50" },
      ],
    });

    const response = await rebalanceRoutes["/api/targets"].GET(
      new Request("http://x/api/targets?by=kind", { headers: { cookie } }),
    );
    const targets = TargetsSchema.parse(await response.json());

    // Accumulating would leave a set summing to 200 %, refused on the next read
    // after the write had already happened.
    expect(targets.map((t) => t.key).sort()).toEqual(["etf", "stock"]);
    expect(targets.every((t) => t.weightPercent === "50.00")).toBe(true);
  });

  test("keeps one user's targets away from another's", async () => {
    const owner = await signUp();
    const stranger = await signUp();
    await putTargets(owner, {
      dimension: "kind",
      targets: [{ key: "stock", weightPercent: "100" }],
    });

    const response = await rebalanceRoutes["/api/targets"].GET(
      new Request("http://x/api/targets?by=kind", { headers: { cookie: stranger } }),
    );

    expect(TargetsSchema.parse(await response.json())).toEqual([]);
  });

  test("refuses an anonymous caller", async () => {
    const response = await rebalanceRoutes["/api/targets"].GET(new Request("http://x/api/targets"));
    expect(response.status).toBe(401);
  });
});

describe("the read routes", () => {
  /** A portfolio holding one instrument, so drift has something to be about. */
  const seed = async (): Promise<string> => {
    const cookie = await signUp();
    const { getDb } = await import("../db");
    const { prices, transactions } = await import("../db/schema");
    const { db } = getDb();

    const accountResponse = await accountRoutes["/api/accounts"].POST(
      new Request("http://x/api/accounts", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ name: "Nordnet", broker: "nordnet" }),
      }),
    );
    // SAFETY: a 201 from POST /api/accounts always returns the inserted row.
    const { id: accountId } = (await accountResponse.json()) as { id: number };

    const isin = `XX${crypto.randomUUID().replace(/-/g, "").toUpperCase().slice(0, 9)}0`;
    const instrumentResponse = await instrumentRoutes["/api/instruments"].POST(
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
    // SAFETY: a 201 from POST /api/instruments always returns the inserted row.
    const { id: instrumentId } = (await instrumentResponse.json()) as { id: number };

    db.insert(transactions)
      .values({
        accountId,
        instrumentId,
        type: "BUY",
        tradeDate: "2025-01-10",
        quantity: 10_000_000,
        unitPrice: 10_00,
        amount: -100_00,
        fee: 5_00,
        tax: 0,
        currency: EUR,
        fxRateEur: 100_000_000,
        contentHash: crypto.randomUUID(),
        externalId: null,
        importId: null,
      })
      .run();
    db.insert(prices)
      .values({
        instrumentId,
        date: "2025-06-02",
        close: 20_00,
        currency: EUR,
        source: "manual",
        fetchedAt: new Date("2025-06-02T00:00:00Z"),
      })
      .run();
    return cookie;
  };

  test("drift reports decimal strings and names each slice", async () => {
    const cookie = await seed();
    await putTargets(cookie, {
      dimension: "kind",
      targets: [{ key: "stock", weightPercent: "100" }],
    });

    const response = await rebalanceRoutes["/api/drift"].GET(
      new Request("http://x/api/drift?by=kind&on=2025-06-02", { headers: { cookie } }),
    );
    const body = z
      .object({
        rows: z.array(
          z.object({ key: z.string(), label: z.string(), driftEur: z.string().nullable() }),
        ),
        totalEur: z.string(),
      })
      .parse(await response.json());

    expect(response.status).toBe(200);
    // 10 shares at 20,00 -- the whole portfolio, and exactly on a 100 % target.
    expect(body.totalEur).toBe("200.00");
    expect(body.rows.find((row) => row.key === "stock")?.driftEur).toBe("0.00");
  });

  test("a fee report counts the commission paid on a purchase", async () => {
    const cookie = await seed();

    const response = await rebalanceRoutes["/api/fees"].GET(
      new Request("http://x/api/fees", { headers: { cookie } }),
    );
    const years = z
      .array(z.object({ year: z.number(), tradeFeesEur: z.string(), withheldTaxEur: z.string() }))
      .parse(await response.json());

    expect(years[0]!.year).toBe(2025);
    expect(years[0]!.tradeFeesEur).toBe("5.00");
    expect(years[0]!.withheldTaxEur).toBe("0.00");
  });

  test("a deposit plan refuses an amount that is not one", async () => {
    const cookie = await seed();
    const response = await rebalanceRoutes["/api/deposit-plan"].GET(
      new Request("http://x/api/deposit-plan?amount=banaani", { headers: { cookie } }),
    );

    expect(response.status).toBe(400);
  });

  test("an unknown grouping is refused rather than silently defaulted", async () => {
    const cookie = await seed();
    const response = await rebalanceRoutes["/api/drift"].GET(
      new Request("http://x/api/drift?by=banaani", { headers: { cookie } }),
    );

    expect(response.status).toBe(400);
  });
});

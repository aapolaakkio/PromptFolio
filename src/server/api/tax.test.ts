import { beforeAll, describe, expect, test } from "vitest";
import { z } from "zod";

import { EUR } from "../../core/money.ts";

// Exercises taxRoutes (src/server/api/tax.ts) against a real migrated database
// and a real Better Auth session, following portfolio.test.ts's setup exactly:
// the shared getDb() handle is already pinned to a migrated in-memory database
// by ../test-setup.ts (a vitest.config.ts `setupFiles` entry), so this file
// must not call resetDbHandleForTests() or migrate() itself. The database is
// shared across every test file in the process, so every identity here is
// derived from a fresh crypto.randomUUID().

let auth: (typeof import("../auth.ts"))["auth"];
let accountRoutes: (typeof import("./accounts.ts"))["accountRoutes"];
let instrumentRoutes: (typeof import("./instruments.ts"))["instrumentRoutes"];
let taxRoutes: (typeof import("./tax.ts"))["taxRoutes"];

beforeAll(async () => {
  auth = (await import("../auth.ts")).auth;
  accountRoutes = (await import("./accounts.ts")).accountRoutes;
  instrumentRoutes = (await import("./instruments.ts")).instrumentRoutes;
  taxRoutes = (await import("./tax.ts")).taxRoutes;
});

const sessionCookieFrom = (response: Response): string => {
  const setCookie = response.headers.getSetCookie().find((c) => c.includes("session_token"));
  if (!setCookie) throw new Error("Response carried no session_token cookie");
  const nameValue = setCookie.split(";")[0];
  if (!nameValue) throw new Error("Malformed Set-Cookie header");
  return nameValue;
};

const signUp = async (email: string): Promise<string> => {
  const response = await auth.handler(
    new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Test User", email, password: "correct horse battery staple" }),
    }),
  );
  if (response.status !== 200) throw new Error(`sign-up failed with status ${response.status}`);
  return sessionCookieFrom(response);
};

const randomIsin = (): string =>
  `XX${crypto.randomUUID().replace(/-/g, "").toUpperCase().slice(0, 9)}0`;

const createAccount = async (cookie: string, accountType: "aot" | "ost"): Promise<number> => {
  const response = await accountRoutes["/api/accounts"].POST(
    new Request("http://x/api/accounts", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "Nordnet", broker: "nordnet", accountType }),
    }),
  );
  expect(response.status).toBe(201);
  // SAFETY: a 201 from POST /api/accounts (asserted above) always returns the
  // inserted row, which carries an `id` column.
  const body = (await response.json()) as { id: number };
  return body.id;
};

const createInstrument = async (cookie: string): Promise<number> => {
  const isin = randomIsin();
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
  // SAFETY: a 201 from POST /api/instruments (asserted above) always returns
  // the inserted row, which carries an `id` column.
  const body = (await response.json()) as { id: number };
  return body.id;
};

/** A buy and a later sale, seeded straight through the shared handle. */
const seedSale = async (
  cookie: string,
  o: { buyDate: string; sellDate: string; principal: number; proceeds: number },
): Promise<void> => {
  const { getDb } = await import("../db/index.ts");
  const { transactions } = await import("../db/schema.ts");
  const { db } = getDb();
  const accountId = await createAccount(cookie, "aot");
  const instrumentId = await createInstrument(cookie);

  const row = (type: "BUY" | "SELL", tradeDate: string, amount: number) => ({
    accountId,
    instrumentId,
    type,
    tradeDate,
    quantity: 10_000_000,
    unitPrice: null,
    amount,
    fee: 0,
    tax: 0,
    currency: EUR,
    fxRateEur: 100_000_000,
    contentHash: crypto.randomUUID(),
    externalId: null,
    importId: null,
  });

  db.insert(transactions)
    .values([row("BUY", o.buyDate, -o.principal), row("SELL", o.sellDate, o.proceeds)])
    .run();
};

const TaxYearSchema = z.object({
  year: z.number(),
  disposals: z.array(
    z.object({
      instrument: z.string(),
      accountName: z.string(),
      gainEur: z.string(),
      method: z.enum(["actual", "deemed"]),
      deemedPercent: z.number(),
      quantity: z.string(),
    }),
  ),
  exempt: z.boolean(),
  netEur: z.string(),
  source: z.object({ transactions: z.number(), earliest: z.string().nullable() }),
});

describe("GET /api/tax", () => {
  test("reports the year's disposals as decimal strings, naming the instrument", () => {
    // A numeric instrument id is an internal detail; every user-facing message
    // in this codebase names the instrument instead.
    return (async () => {
      const cookie = await signUp(`tax-${crypto.randomUUID()}@example.com`);
      await seedSale(cookie, {
        buyDate: "2020-01-10",
        sellDate: "2025-06-01",
        principal: 100_000,
        proceeds: 500_000,
      });

      const response = await taxRoutes["/api/tax"].GET(
        new Request("http://x/api/tax?year=2025", { headers: { cookie } }),
      );
      expect(response.status).toBe(200);
      const body = TaxYearSchema.parse(await response.json());

      expect(body.year).toBe(2025);
      expect(body.disposals).toHaveLength(1);
      expect(body.disposals[0]!.instrument).toBe("Test Co");
      expect(body.disposals[0]!.accountName).toBe("Nordnet");
      // Held under ten years: the deemed cost is 20 % of 5 000,00 = 1 000,00,
      // giving a 4 000,00 gain against the actual 4 000,00 -- equal, so the
      // actual method stands.
      expect(body.disposals[0]!.deemedPercent).toBe(20);
      expect(body.disposals[0]!.gainEur).toBe("4000.00");
      expect(body.disposals[0]!.quantity).toBe("10.000000");
      expect(body.netEur).toBe("4000.00");
      expect(body.source.transactions).toBe(2);
    })();
  });

  test("says a small year is exempt rather than reporting a gain", async () => {
    const cookie = await signUp(`tax-small-${crypto.randomUUID()}@example.com`);
    await seedSale(cookie, {
      buyDate: "2020-01-10",
      sellDate: "2025-06-01",
      principal: 10_000,
      proceeds: 90_000,
    });

    const response = await taxRoutes["/api/tax"].GET(
      new Request("http://x/api/tax?year=2025", { headers: { cookie } }),
    );
    const body = TaxYearSchema.parse(await response.json());

    expect(body.exempt).toBe(true);
    expect(body.netEur).toBe("0.00");
  });

  test("never returns another user's disposals", async () => {
    const owner = await signUp(`tax-owner-${crypto.randomUUID()}@example.com`);
    const stranger = await signUp(`tax-stranger-${crypto.randomUUID()}@example.com`);
    await seedSale(owner, {
      buyDate: "2020-01-10",
      sellDate: "2025-06-01",
      principal: 100_000,
      proceeds: 500_000,
    });

    const response = await taxRoutes["/api/tax"].GET(
      new Request("http://x/api/tax?year=2025", { headers: { cookie: stranger } }),
    );
    const body = TaxYearSchema.parse(await response.json());

    expect(body.disposals).toEqual([]);
  });

  test("refuses an anonymous caller", async () => {
    const response = await taxRoutes["/api/tax"].GET(new Request("http://x/api/tax?year=2025"));
    expect(response.status).toBe(401);
  });

  test("rejects a year that is not one", async () => {
    const cookie = await signUp(`tax-bad-${crypto.randomUUID()}@example.com`);
    for (const year of ["banaani", "", "12"]) {
      const response = await taxRoutes["/api/tax"].GET(
        new Request(`http://x/api/tax?year=${year}`, { headers: { cookie } }),
      );
      expect(response.status).toBe(400);
    }
  });
});

describe("GET /api/tax/years", () => {
  test("lists the years with a taxable event, newest first", async () => {
    const cookie = await signUp(`tax-years-${crypto.randomUUID()}@example.com`);
    await seedSale(cookie, {
      buyDate: "2020-01-10",
      sellDate: "2023-06-01",
      principal: 100_000,
      proceeds: 500_000,
    });
    await seedSale(cookie, {
      buyDate: "2020-01-10",
      sellDate: "2025-06-01",
      principal: 100_000,
      proceeds: 500_000,
    });

    const response = await taxRoutes["/api/tax/years"].GET(
      new Request("http://x/api/tax/years", { headers: { cookie } }),
    );
    expect(response.status).toBe(200);
    expect(z.array(z.number()).parse(await response.json())).toEqual([2025, 2023]);
  });
});

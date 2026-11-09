import { beforeAll, describe, expect, test } from "vitest";
import { CreateAccount, openAccount as openAccountRow } from "./accounts.ts";
import { db } from "./db/index.ts";
import { addInstrument } from "./instruments/store.ts";

import { EUR } from "../core/money.ts";

// Exercises the tax report (tax.ts) against a real migrated database and Better Auth session (setup as in portfolio.test.ts). Identities are random because the database is shared.

let auth: ReturnType<(typeof import("./auth.ts"))["getAuth"]>;
let taxYearFor: (typeof import("./tax.ts"))["taxYearFor"];
let taxYearsFor: (typeof import("./tax.ts"))["taxYearsFor"];

beforeAll(async () => {
  auth = (await import("./auth.ts")).getAuth();
  ({ taxYearFor, taxYearsFor } = await import("./tax.ts"));
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
  `XX${crypto.randomUUID().replace(/-/g, "").toUpperCase().slice(0, 9)}0`;

const createAccount = async (userId: string, accountType: "aot" | "ost"): Promise<number> =>
  (
    await openAccountRow(
      db,
      userId,
      CreateAccount.parse({ name: "Nordnet", broker: "nordnet", accountType }),
    )
  ).id;

const createInstrument = async (): Promise<number> => {
  const isin = randomIsin();
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

/** A buy and a later sale, seeded straight through the shared handle. */
const seedSale = async (
  userId: string,
  o: { buyDate: string; sellDate: string; principal: number; proceeds: number },
): Promise<void> => {
  const { db } = await import("./db/index.ts");
  const { transactions } = await import("./db/schema.ts");
  const accountId = await createAccount(userId, "aot");
  const instrumentId = await createInstrument();

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

  await db
    .insert(transactions)
    .values([row("BUY", o.buyDate, -o.principal), row("SELL", o.sellDate, o.proceeds)])
    .run();
};

describe("taxYearFor", () => {
  test("reports the year's disposals as decimal strings, naming the instrument", () => {
    // A numeric instrument id is internal; user-facing messages name the instrument.
    return (async () => {
      const { userId } = await signUp(`tax-${crypto.randomUUID()}@example.com`);
      await seedSale(userId, {
        buyDate: "2020-01-10",
        sellDate: "2025-06-01",
        principal: 100_000,
        proceeds: 500_000,
      });

      const body = await taxYearFor(db, userId, 2025);

      expect(body.year).toBe(2025);
      expect(body.disposals).toHaveLength(1);
      expect(body.disposals[0]!.instrument).toBe("Test Co");
      expect(body.disposals[0]!.accountName).toBe("Nordnet");
      // Held under ten years: deemed cost 20 % of 5 000.00 = 1 000.00, a 4 000.00 gain equal to the actual one, so the actual method stands.
      expect(body.disposals[0]!.deemedPercent).toBe(20);
      expect(body.disposals[0]!.gainEur).toBe("4000.00");
      expect(body.disposals[0]!.quantity).toBe("10.000000");
      expect(body.netEur).toBe("4000.00");
      expect(body.source.transactions).toBe(2);
    })();
  });

  test("says a small year is exempt rather than reporting a gain", async () => {
    const { userId } = await signUp(`tax-small-${crypto.randomUUID()}@example.com`);
    await seedSale(userId, {
      buyDate: "2020-01-10",
      sellDate: "2025-06-01",
      principal: 10_000,
      proceeds: 90_000,
    });

    const body = await taxYearFor(db, userId, 2025);

    expect(body.exempt).toBe(true);
    expect(body.netEur).toBe("0.00");
  });

  test("never returns another user's disposals", async () => {
    const owner = await signUp(`tax-owner-${crypto.randomUUID()}@example.com`);
    const stranger = await signUp(`tax-stranger-${crypto.randomUUID()}@example.com`);
    await seedSale(owner.userId, {
      buyDate: "2020-01-10",
      sellDate: "2025-06-01",
      principal: 100_000,
      proceeds: 500_000,
    });

    const body = await taxYearFor(db, stranger.userId, 2025);

    expect(body.disposals).toEqual([]);
  });
});

describe("taxYearsFor", () => {
  test("lists the years with a taxable event, newest first", async () => {
    const { userId } = await signUp(`tax-years-${crypto.randomUUID()}@example.com`);
    await seedSale(userId, {
      buyDate: "2020-01-10",
      sellDate: "2023-06-01",
      principal: 100_000,
      proceeds: 500_000,
    });
    await seedSale(userId, {
      buyDate: "2020-01-10",
      sellDate: "2025-06-01",
      principal: 100_000,
      proceeds: 500_000,
    });

    expect(await taxYearsFor(db, userId)).toEqual([2025, 2023]);
  });
});

import { beforeAll, describe, expect, test } from "bun:test";

import { EUR } from "../core/money";

// Covers the OST valuation and the view mapping in src/server/tax.ts, which
// the route-level tests in api/tax.test.ts do not reach. Same setup rules as
// every other server test: the shared getDb() handle is already pinned to a
// migrated in-memory database by ./test-setup.ts, and every identity here is
// derived from a fresh crypto.randomUUID().

let auth: (typeof import("./auth"))["auth"];
let taxYearFor: (typeof import("./tax"))["taxYearFor"];

beforeAll(async () => {
  auth = (await import("./auth")).auth;
  taxYearFor = (await import("./tax")).taxYearFor;
});

const signUp = async (): Promise<string> => {
  const response = await auth.handler(
    new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Test User",
        email: `tax-server-${crypto.randomUUID()}@example.com`,
        password: "correct horse battery staple",
      }),
    }),
  );
  if (response.status !== 200) throw new Error(`sign-up failed with status ${response.status}`);
  // SAFETY: a 200 from POST /sign-up/email is Better Auth's documented success
  // response, which always carries `{ user: { id, ... } }`.
  const body = (await response.json()) as { user: { id: string } };
  return body.user.id;
};

type Seeded = { userId: string; accountId: number; instrumentId: number };

/**
 * An equity savings account holding one priced share, funded by a deposit,
 * with a dividend paid into an ordinary account alongside it.
 */
const seedOst = async (o: { priced: boolean }): Promise<Seeded> => {
  const { getDb } = await import("./db");
  const { accounts, instruments, prices, transactions } = await import("./db/schema");
  const { db } = getDb();
  const userId = await signUp();

  const accountId = db
    .insert(accounts)
    .values({
      userId,
      name: "OST",
      broker: "nordnet",
      accountType: "ost",
      kind: "brokerage",
    })
    .returning({ id: accounts.id })
    .all()[0]!.id;
  const ordinaryId = db
    .insert(accounts)
    .values({
      userId,
      name: "AOT",
      broker: "nordnet",
      accountType: "aot",
      kind: "brokerage",
    })
    .returning({ id: accounts.id })
    .all()[0]!.id;

  const isin = `XX${crypto.randomUUID().replace(/-/g, "").toUpperCase().slice(0, 9)}0`;
  const instrumentId = db
    .insert(instruments)
    .values({
      isin,
      ticker: "OST",
      name: "Ost Co",
      kind: "stock",
      currency: EUR,
      priceSource: "manual",
      sourceKey: isin,
    })
    .returning({ id: instruments.id })
    .all()[0]!.id;

  const row = (o2: {
    accountId: number;
    type: "DEPOSIT" | "WITHDRAWAL" | "BUY" | "DIVIDEND";
    tradeDate: string;
    amount: number;
    quantity?: number;
    instrument?: number | null;
  }) => ({
    accountId: o2.accountId,
    instrumentId: o2.instrument ?? null,
    type: o2.type,
    tradeDate: o2.tradeDate,
    quantity: o2.quantity ?? 0,
    unitPrice: null,
    amount: o2.amount,
    fee: 0,
    tax: 0,
    currency: EUR,
    fxRateEur: 100_000_000,
    contentHash: crypto.randomUUID(),
    externalId: null,
    importId: null,
  });

  db.insert(transactions)
    .values([
      row({
        accountId,
        type: "DEPOSIT",
        tradeDate: "2024-01-02",
        amount: 100_000,
      }),
      row({
        accountId,
        type: "BUY",
        tradeDate: "2024-01-03",
        amount: -100_000,
        quantity: 10_000_000,
        instrument: instrumentId,
      }),
      row({
        accountId,
        type: "WITHDRAWAL",
        tradeDate: "2025-06-02",
        amount: -30_000,
      }),
      row({
        accountId: ordinaryId,
        type: "DIVIDEND",
        tradeDate: "2025-04-07",
        amount: 10_000,
        instrument: instrumentId,
      }),
    ])
    .run();

  if (o.priced) {
    // 10 shares at 200,00 -> 2 000,00 on the account, against 1 000,00 paid in.
    db.insert(prices)
      .values({
        instrumentId,
        date: "2025-06-02",
        close: 20_000,
        currency: EUR,
        source: "manual",
        fetchedAt: new Date("2025-06-02T00:00:00Z"),
      })
      .run();
  }

  return { userId, accountId, instrumentId };
};

describe("taxYearFor", () => {
  test("apportions an OST withdrawal and names the account", async () => {
    const { userId } = await seedOst({ priced: true });
    const { getDb } = await import("./db");

    const report = taxYearFor(getDb().db, userId, 2025);
    const ost = report.ost[0]!;

    expect(ost.accountName).toBe("OST");
    expect(ost.withdrawals).toHaveLength(1);
    const withdrawal = ost.withdrawals[0]!;
    // 2 000,00 on the account of which 1 000,00 is profit; 300,00 withdrawn
    // -> half of it is profit.
    expect(withdrawal.valueEur).toBe("2000.00");
    expect(withdrawal.profitEur).toBe("1000.00");
    expect(withdrawal.taxableEur).toBe("150.00");
    expect(withdrawal.blockedBy).toBeNull();
    // 1 000,00 paid in, 150,00 of the withdrawal was capital returned.
    expect(ost.depositedEur).toBe("850.00");
    expect(ost.incomplete).toBe(false);
  });

  test("names the unpriced instrument instead of guessing a withdrawal's tax", async () => {
    const { userId } = await seedOst({ priced: false });
    const { getDb } = await import("./db");

    const withdrawal = taxYearFor(getDb().db, userId, 2025).ost[0]!.withdrawals[0]!;

    expect(withdrawal.taxableEur).toBeNull();
    expect(withdrawal.blockedBy).toContain("Ost Co");
    expect(withdrawal.blockedBy).toContain("2025-06-02");
    // The remedy is an existing flow, so the message says what to do.
    expect(withdrawal.blockedBy).toContain("Kirjaa hinta");
  });

  test("reports a dividend's taxable share and flags the missing withholding", async () => {
    const { userId } = await seedOst({ priced: true });
    const { getDb } = await import("./db");

    const report = taxYearFor(getDb().db, userId, 2025);

    expect(report.dividends).toHaveLength(1);
    expect(report.dividends[0]!.instrument).toBe("Ost Co");
    expect(report.dividends[0]!.grossEur).toBe("100.00");
    expect(report.dividends[0]!.taxableEur).toBe("85.00");
    // No broker export separates the withholding, so this must never read as
    // "nothing was withheld".
    expect(report.dividends[0]!.withholdingRecorded).toBe(false);
    expect(report.dividendTaxableEur).toBe("85.00");
  });

  test("leaves an OST sale out of the taxable disposals", async () => {
    const { userId } = await seedOst({ priced: true });
    const { getDb } = await import("./db");

    expect(taxYearFor(getDb().db, userId, 2025).disposals).toEqual([]);
  });
});

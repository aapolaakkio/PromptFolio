import { beforeAll, describe, expect, test } from "vitest";

import { EUR } from "../core/money.ts";

// Covers the OST valuation and view mapping in tax.ts, which the route-level tests in api/tax.test.ts do not reach. Identities derive from a fresh crypto.randomUUID().

let auth: ReturnType<(typeof import("./auth.ts"))["getAuth"]>;
let taxYearFor: (typeof import("./tax.ts"))["taxYearFor"];

beforeAll(async () => {
  auth = (await import("./auth.ts")).getAuth();
  taxYearFor = (await import("./tax.ts")).taxYearFor;
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
  // SAFETY: Better Auth's sign-up response always carries `{ user: { id } }`.
  const body = (await response.json()) as { user: { id: string } };
  return body.user.id;
};

type Seeded = { userId: string; accountId: number; instrumentId: number };

/** An OST holding one priced share, funded by a deposit, plus a dividend into an ordinary account. */
const seedOst = async (o: { priced: boolean; withdrawnOn?: string }): Promise<Seeded> => {
  const { db } = await import("./db/index.ts");
  const { accounts, instruments, prices, transactions } = await import("./db/schema.ts");
  const userId = await signUp();

  const accountId = (
    await db
      .insert(accounts)
      .values({
        userId,
        name: "OST",
        broker: "nordnet",
        accountType: "ost",
        kind: "brokerage",
      })
      .returning({ id: accounts.id })
      .all()
  )[0]!.id;
  const ordinaryId = (
    await db
      .insert(accounts)
      .values({
        userId,
        name: "AOT",
        broker: "nordnet",
        accountType: "aot",
        kind: "brokerage",
      })
      .returning({ id: accounts.id })
      .all()
  )[0]!.id;

  const isin = `XX${crypto.randomUUID().replace(/-/g, "").toUpperCase().slice(0, 9)}0`;
  const instrumentId = (
    await db
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
      .all()
  )[0]!.id;

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

  await db
    .insert(transactions)
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
        tradeDate: o.withdrawnOn ?? "2025-06-02",
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
    await db
      .insert(prices)
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
    const { db } = await import("./db/index.ts");

    const report = await taxYearFor(db, userId, 2025);
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

  test("does not ask for a price the weekend could not have", async () => {
    // A Sunday withdrawal is valued from the Friday close, the freshest price that can exist; comparing dates directly (instead of `isPriceStale`) made every non-trading day look like a gap.
    const { userId, instrumentId } = await seedOst({ priced: false, withdrawnOn: "2025-06-08" });
    const { db } = await import("./db/index.ts");
    const { prices } = await import("./db/schema.ts");
    await db
      .insert(prices)
      .values({
        instrumentId,
        date: "2025-06-06",
        close: 20_000,
        currency: EUR,
        source: "manual",
        fetchedAt: new Date("2025-06-06T00:00:00Z"),
      })
      .run();

    const withdrawal = (await taxYearFor(db, userId, 2025)).ost[0]!.withdrawals[0]!;

    expect(withdrawal.taxableEur).not.toBeNull();
    expect(withdrawal.pricedFrom).toBeNull();
  });

  test("names the unpriced instrument instead of guessing a withdrawal's tax", async () => {
    const { userId } = await seedOst({ priced: false });
    const { db } = await import("./db/index.ts");

    const withdrawal = (await taxYearFor(db, userId, 2025)).ost[0]!.withdrawals[0]!;

    expect(withdrawal.taxableEur).toBeNull();
    expect(withdrawal.blockedBy).toContain("Ost Co");
    expect(withdrawal.blockedBy).toContain("2025-06-02");
    // The remedy is an existing flow, so the message says what to do.
    expect(withdrawal.blockedBy).toContain("Record a price");
  });

  test("reports a dividend's taxable share and flags the missing withholding", async () => {
    const { userId } = await seedOst({ priced: true });
    const { db } = await import("./db/index.ts");

    const report = await taxYearFor(db, userId, 2025);

    expect(report.dividends).toHaveLength(1);
    expect(report.dividends[0]!.instrument).toBe("Ost Co");
    expect(report.dividends[0]!.grossEur).toBe("100.00");
    expect(report.dividends[0]!.taxableEur).toBe("85.00");
    // No export separates the withholding, so it must never read as "nothing was withheld".
    expect(report.dividends[0]!.withholdingRecorded).toBe(false);
    expect(report.dividendTaxableEur).toBe("85.00");
  });

  test("leaves an OST sale out of the taxable disposals", async () => {
    const { userId } = await seedOst({ priced: true });
    const { db } = await import("./db/index.ts");

    expect((await taxYearFor(db, userId, 2025)).disposals).toEqual([]);
  });
});

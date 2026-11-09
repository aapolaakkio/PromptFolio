import { beforeAll, describe, expect, test } from "vitest";
import { CreateAccount, openAccount as openAccountRow } from "../accounts.ts";
import { db } from "../db/index.ts";
import { instrumentCosts } from "../db/schema.ts";
import { addInstrument } from "../instruments/store.ts";

import { EUR } from "../../core/money.ts";

// Chat tool results are what the user is told, so these assert exact strings and that every result carries its date and staleness.

let auth: ReturnType<(typeof import("../auth.ts"))["getAuth"]>;
let saveTargets: (typeof import("../rebalance.ts"))["saveTargets"];
let addRules: (typeof import("../spending/rules.ts"))["addRules"];
let buildChatTools: (typeof import("./tools.ts"))["buildChatTools"];
let transactions: (typeof import("../db/schema.ts"))["transactions"];
let prices: (typeof import("../db/schema.ts"))["prices"];
let snapshots: (typeof import("../db/schema.ts"))["snapshots"];
let snapshotRows: (typeof import("../db/schema.ts"))["snapshotRows"];

beforeAll(async () => {
  auth = (await import("../auth.ts")).getAuth();
  saveTargets = (await import("../rebalance.ts")).saveTargets;
  addRules = (await import("../spending/rules.ts")).addRules;
  buildChatTools = (await import("./tools.ts")).buildChatTools;
  transactions = (await import("../db/schema.ts")).transactions;
  prices = (await import("../db/schema.ts")).prices;
  snapshots = (await import("../db/schema.ts")).snapshots;
  snapshotRows = (await import("../db/schema.ts")).snapshotRows;
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
  `FI${crypto.randomUUID().replace(/-/g, "").toUpperCase().slice(0, 9)}0`;

const createAccount = async (userId: string, name = "Nordnet"): Promise<number> =>
  (await openAccountRow(db, userId, CreateAccount.parse({ name, broker: "nordnet" }))).id;

const createBankAccount = async (userId: string): Promise<number> =>
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

const createInstrument = async (cookie: string, name: string): Promise<number> => {
  const response = await addInstrument(db, {
    isin: randomIsin(),
    ticker: null,
    name,
    kind: "fund",
    currency: EUR,
    priceSource: "manual",
  });
  return response.id;
};

const buy = async (accountId: number, instrumentId: number, date: string): Promise<void> => {
  await db
    .insert(transactions)
    .values({
      accountId,
      instrumentId,
      type: "BUY",
      tradeDate: date,
      quantity: 10_000_000,
      unitPrice: 1000,
      amount: -10_000,
      fee: 0,
      tax: 0,
      currency: EUR,
      fxRateEur: 100_000_000,
      contentHash: crypto.randomUUID(),
    })
    .run();
};

const deposit = async (accountId: number, date: string, minor: number): Promise<void> => {
  await db
    .insert(transactions)
    .values({
      accountId,
      instrumentId: null,
      type: "DEPOSIT",
      tradeDate: date,
      quantity: 0,
      unitPrice: 0,
      amount: minor,
      fee: 0,
      tax: 0,
      currency: EUR,
      fxRateEur: 100_000_000,
      contentHash: crypto.randomUUID(),
    })
    .run();
};

const spend = async (
  accountId: number,
  note: string,
  minor: number,
  date: string,
): Promise<void> => {
  await db
    .insert(transactions)
    .values({
      accountId,
      instrumentId: null,
      type: "WITHDRAWAL",
      tradeDate: date,
      quantity: 0,
      unitPrice: null,
      amount: minor,
      fee: 0,
      tax: 0,
      currency: EUR,
      fxRateEur: 100_000_000,
      contentHash: crypto.randomUUID(),
      note,
    })
    .run();
};

const receive = async (
  accountId: number,
  note: string,
  minor: number,
  date: string,
): Promise<void> => {
  await db
    .insert(transactions)
    .values({
      accountId,
      instrumentId: null,
      type: "DEPOSIT",
      tradeDate: date,
      quantity: 0,
      unitPrice: null,
      amount: minor,
      fee: 0,
      tax: 0,
      currency: EUR,
      fxRateEur: 100_000_000,
      contentHash: crypto.randomUUID(),
      note,
    })
    .run();
};

const price = async (instrumentId: number, date: string, minor: number): Promise<void> => {
  await db
    .insert(prices)
    .values({
      instrumentId,
      date,
      close: minor,
      currency: EUR,
      source: "manual",
      fetchedAt: new Date(`${date}T12:00:00Z`),
    })
    .run();
};

const statement = async (
  accountId: number,
  instrumentId: number,
  units: number,
  asOf: string,
): Promise<void> => {
  const snapshot = (
    await db
      .insert(snapshots)
      .values({ accountId, asOf, source: "manual" })
      .returning({ id: snapshots.id })
      .all()
  )[0];
  if (!snapshot) throw new Error("snapshot insert returned nothing");
  await db
    .insert(snapshotRows)
    .values({
      snapshotId: snapshot.id,
      instrumentId,
      quantity: units * 1_000_000,
      nav: 1200,
      marketValue: units * 1200,
    })
    .run();
};

type Tools = Awaited<ReturnType<typeof buildChatTools>>;
const toolNamed = (tools: Tools, name: string): Tools[number] => {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`No tool named ${name}`);
  return tool;
};

const seed = async (): Promise<{
  tools: Tools;
  instrumentId: number;
  accountId: number;
  bankAccountId: number;
  cookie: string;
  userId: string;
}> => {
  const { userId, cookie } = await signUp(`chat-${crypto.randomUUID()}@example.com`);
  const accountId = await createAccount(userId);
  const bankAccountId = await createBankAccount(userId);
  const instrumentId = await createInstrument(cookie, "Testirahasto");
  await deposit(accountId, "2026-01-01", 100_000);
  await buy(accountId, instrumentId, "2026-01-02");
  await price(instrumentId, "2026-01-02", 1000);
  await price(instrumentId, "2026-06-01", 1200);
  return {
    tools: buildChatTools(db, userId),
    instrumentId,
    accountId,
    bankAccountId,
    cookie,
    userId,
  };
};

describe("get_holdings", () => {
  test("reports quantity, cost and value as decimal strings for the asked date", async () => {
    const { tools } = await seed();
    // SAFETY: the tool's literal has this shape.
    const result = (await toolNamed(tools, "get_holdings").run({ on: "2026-06-01" })) as {
      asOf: string;
      stale: boolean;
      holdings: Array<{ name: string; quantity: string; costEur: string; valueEur: string }>;
    };

    expect(result.asOf).toBe("2026-06-01");
    expect(result.holdings).toHaveLength(1);
    expect(result.holdings[0]?.name).toBe("Testirahasto");
    expect(result.holdings[0]?.quantity).toBe("10.000000");
    expect(result.holdings[0]?.costEur).toBe("100.00");
    expect(result.holdings[0]?.valueEur).toBe("120.00");
    expect(result.stale).toBe(false);
  });

  test("refuses a date that is not YYYY-MM-DD rather than guessing one", async () => {
    const { tools } = await seed();
    await expect(toolNamed(tools, "get_holdings").run({ on: "1.6.2026" })).rejects.toThrow();
  });

  test("refuses an unknown argument, so a hallucinated parameter cannot pass silently", async () => {
    const { tools } = await seed();
    expect(toolNamed(tools, "get_holdings").schema.safeParse({ userId: "someone" }).success).toBe(
      false,
    );
  });
});

describe("scoping", () => {
  test("sees only the calling user's own holdings", async () => {
    const { tools: mine } = await seed();
    await seed();
    // SAFETY: the tool's literal has this shape.
    const result = (await mine
      .find((t) => t.name === "get_holdings")
      ?.run({ on: "2026-06-01" })) as {
      holdings: unknown[];
    };
    expect(result.holdings).toHaveLength(1);
  });

  test("names only instruments the user's own ledger references", async () => {
    const { tools: mine } = await seed();
    await seed();
    // SAFETY: the tool's literal has this shape.
    const result = (await toolNamed(mine, "get_instruments").run({})) as { instruments: unknown[] };
    expect(result.instruments).toHaveLength(1);
  });
});

describe("get_fund_costs", () => {
  test("lists each holding's charge and yearly cost, and the yearly total", async () => {
    const { tools, instrumentId } = await seed();
    await db
      .insert(instrumentCosts)
      .values({
        instrumentId,
        ongoingChargeBp: 50,
        sourceUrl: "https://funds.example.fi/x",
        checkedAt: 1,
        source: "ai",
      })
      .run();
    // SAFETY: the tool's literal has this shape.
    const result = (await toolNamed(tools, "get_fund_costs").run({})) as {
      totalYearlyCostEur: string;
      unknownCount: number;
      holdings: Array<{
        name: string;
        ongoingChargePercent: string | null;
        yearlyCostEur: string | null;
        source: string | null;
        sourceUrl: string | null;
      }>;
    };
    expect(result.holdings[0]).toMatchObject({
      name: "Testirahasto",
      ongoingChargePercent: "0.50",
      yearlyCostEur: "0.60",
      source: "ai",
      sourceUrl: "https://funds.example.fi/x",
    });
    expect(result.totalYearlyCostEur).toBe("0.60");
    expect(result.unknownCount).toBe(0);
  });

  test("an unknown fee is null, never zero", async () => {
    const { tools } = await seed();
    // SAFETY: the tool's literal has this shape.
    const result = (await toolNamed(tools, "get_fund_costs").run({})) as {
      totalYearlyCostEur: string | null;
      unknownCount: number;
      holdings: Array<{ ongoingChargePercent: string | null }>;
    };
    expect(result.holdings[0]?.ongoingChargePercent).toBeNull();
    expect(result.totalYearlyCostEur).toBeNull();
    expect(result.unknownCount).toBe(1);
  });
});

describe("get_cash", () => {
  test("reports the deposit that has not been invested, per account", async () => {
    const { tools } = await seed();
    // SAFETY: the tool's literal has this shape.
    const result = (await toolNamed(tools, "get_cash").run({ on: "2026-06-01" })) as {
      asOf: string;
      totalEur: string;
      balances: Array<{ account: string; currency: string; amount: string }>;
    };

    expect(result.asOf).toBe("2026-06-01");
    expect(result.totalEur).toBe("900.00");
    expect(result.balances).toEqual([
      expect.objectContaining({ account: "Nordnet", currency: EUR, amount: "900.00" }),
    ]);
  });

  test("get_holdings names the same cash total, so worth needs no arithmetic in prose", async () => {
    const { tools } = await seed();
    // SAFETY: as above.
    const holdings = (await toolNamed(tools, "get_holdings").run({ on: "2026-06-01" })) as {
      cashEur: string;
    };
    expect(holdings.cashEur).toBe("900.00");
  });
});

describe("get_allocation", () => {
  test("splits by the requested dimension and totals to one", async () => {
    const { tools } = await seed();
    // SAFETY: the tool's literal has this shape.
    const result = (await toolNamed(tools, "get_allocation").run({
      on: "2026-06-01",
      dimension: "currency",
    })) as {
      dimension: string;
      slices: Array<{ label: string; valueEur: string; weight: number }>;
    };

    expect(result.dimension).toBe("currency");
    expect(result.slices).toEqual([{ label: "EUR", valueEur: "1020.00", weight: 1 }]);
  });
});

describe("get_returns", () => {
  test("returns twr and mwr, and says which period they cover", async () => {
    const { tools } = await seed();
    // SAFETY: the tool's literal has this shape.
    const result = (await toolNamed(tools, "get_returns").run({
      from: "2026-01-01",
      to: "2026-06-01",
    })) as { from: string; to: string; valueEur: string; twr: number | null; mwr: number | null };

    expect(result.from).toBe("2026-01-01");
    expect(result.to).toBe("2026-06-01");
    expect(result.valueEur).toBe("120.00");
    expect(result.twr).toBeCloseTo(0.2, 6);
    expect(result.mwr).not.toBeNull();
  });
});

describe("get_value_series", () => {
  test("thins a long period instead of truncating it, keeping both ends", async () => {
    const { tools } = await seed();
    // SAFETY: the tool's literal has this shape.
    const result = (await toolNamed(tools, "get_value_series").run({
      from: "2026-01-01",
      to: "2026-06-01",
    })) as { points: Array<{ date: string; valueEur: string }> };

    expect(result.points.length).toBeLessThanOrEqual(60);
    expect(result.points[0]?.date).toBe("2026-01-01");
    expect(result.points.at(-1)?.date).toBe("2026-06-01");
    expect(result.points.at(-1)?.valueEur).toBe("120.00");
  });
});

describe("get_transactions", () => {
  test("returns newest first and says when the answer was cut short", async () => {
    const { tools } = await seed();
    // SAFETY: the tool's literal has this shape.
    const result = (await toolNamed(tools, "get_transactions").run({ limit: 1 })) as {
      returned: number;
      truncated: boolean;
      transactions: Array<{ date: string; type: string; instrument: string | null }>;
    };

    expect(result.returned).toBe(1);
    expect(result.truncated).toBe(true);
    expect(result.transactions[0]?.type).toBe("BUY");
    expect(result.transactions[0]?.instrument).toBe("Testirahasto");
  });
});

describe("payload limits", () => {
  test("caps a multi-year series at 60 points, keeping the last day", async () => {
    const { tools } = await seed();
    // SAFETY: the tool's literal has this shape.
    const result = (await toolNamed(tools, "get_value_series").run({
      from: "2020-01-01",
      to: "2026-06-01",
    })) as { points: Array<{ date: string }> };

    expect(result.points.length).toBeLessThanOrEqual(60);
    expect(result.points.at(-1)?.date).toBe("2026-06-01");
  });

  test("returns 25 transactions by default and says the answer was cut short", async () => {
    const { tools, accountId, instrumentId } = await seed();
    for (let day = 1; day <= 28; day += 1) {
      await buy(accountId, instrumentId, `2026-03-${String(day).padStart(2, "0")}`);
    }
    // SAFETY: as above.
    const result = (await toolNamed(tools, "get_transactions").run({})) as {
      returned: number;
      truncated: boolean;
    };

    expect(result.returned).toBe(25);
    expect(result.truncated).toBe(true);
  });
});

describe("get_spending", () => {
  test("returns totals already added up, per category", async () => {
    const { tools, bankAccountId } = await seed();
    await spend(bankAccountId, "PKORTTIMAKSU — K-MARKET EXAMPLE", -4215, "2026-03-01");
    await spend(bankAccountId, "PKORTTIMAKSU — LIDL HELSINKI", -3120, "2026-03-02");
    await spend(bankAccountId, "PKORTTIMAKSU — RAVINTOLA EXAMPLE", -1850, "2026-03-03");

    // SAFETY: the tool's literal has this shape.
    const result = (await toolNamed(tools, "get_spending").run({
      from: "2026-01-01",
      to: "2026-12-31",
    })) as {
      totalEur: string;
      groups: Array<{ label: string; totalEur: string; count: number }>;
      uncategorisedShare: number;
    };

    const food = result.groups.find((group) => group.label === "Groceries");
    expect(food?.totalEur).toBe("-73.35");
    expect(food?.count).toBe(2);
    expect(result.totalEur).toBe("-91.85");
    expect(result.uncategorisedShare).toBe(0);
  });

  test("groups by counterparty when asked", async () => {
    const { tools, bankAccountId } = await seed();
    await spend(bankAccountId, "PKORTTIMAKSU — K-MARKET EXAMPLE", -4215, "2026-03-01");
    await spend(bankAccountId, "PKORTTIMAKSU — K-MARKET EXAMPLE", -1785, "2026-03-02");

    // SAFETY: as above.
    const result = (await toolNamed(tools, "get_spending").run({
      from: "2026-01-01",
      to: "2026-12-31",
      groupBy: "counterparty",
    })) as { groups: Array<{ label: string; totalEur: string }> };

    expect(result.groups[0]?.label).toBe("K-MARKET EXAMPLE");
    expect(result.groups[0]?.totalEur).toBe("-60.00");
  });
});

describe("get_uncategorised_spending", () => {
  test("names the merchants no rule matched, so the model can propose a class", async () => {
    const { tools, bankAccountId } = await seed();
    await spend(bankAccountId, "PKORTTIMAKSU — K-MARKET EXAMPLE", -4215, "2026-03-01");
    await spend(bankAccountId, "PKORTTIMAKSU — JOKIN TUNTEMATON LIIKE", -1000, "2026-03-02");
    await spend(bankAccountId, "PKORTTIMAKSU — JOKIN TUNTEMATON LIIKE", -500, "2026-03-03");

    // SAFETY: the tool's literal has this shape.
    const result = (await toolNamed(tools, "get_uncategorised_spending").run({
      from: "2026-01-01",
      to: "2026-12-31",
    })) as {
      totalEur: string;
      merchants: Array<{ name: string; totalEur: string; count: number }>;
    };

    expect(result.merchants).toHaveLength(1);
    expect(result.merchants[0]?.name).toBe("JOKIN TUNTEMATON LIIKE");
    expect(result.merchants[0]?.totalEur).toBe("-15.00");
    expect(result.totalEur).toBe("-15.00");
  });
});

describe("calculate", () => {
  test("adds exactly, which is the point of doing it here rather than in prose", async () => {
    const { tools } = await seed();
    // SAFETY: as above.
    const result = (await toolNamed(tools, "calculate").run({
      operation: "sum",
      values: ["0.10", "0.20"],
    })) as { result: string; working: string };

    expect(result.result).toBe("0.30");
    expect(result.working).toBe("0.10 + 0.20 = 0.30");
  });

  test("returns a bad calculation as a message the model can act on", async () => {
    const { tools } = await seed();
    // SAFETY: as above.
    const result = (await toolNamed(tools, "calculate").run({
      operation: "divide",
      values: ["10.00", "0"],
    })) as { error?: string };

    expect(result.error).toContain("divide by zero");
  });
});

describe("get_instruments", () => {
  test("lists the registered instruments", async () => {
    const { tools } = await seed();
    // SAFETY: the tool's literal has this shape.
    const result = (await toolNamed(tools, "get_instruments").run({})) as {
      instruments: Array<{ name: string; kind: string; currency: string }>;
    };
    expect(result.instruments).toEqual([
      expect.objectContaining({ name: "Testirahasto", kind: "fund", currency: "EUR" }),
    ]);
  });
});

describe("get_tax_year", () => {
  test("reports taxable income for the year, and never a euro of tax owed", async () => {
    const { tools } = await seed();
    // SAFETY: the tool's literal has this shape.
    const result = (await toolNamed(tools, "get_tax_year").run({ year: 2026 })) as {
      year: number;
      availableYears: readonly number[];
      taxableGainEur: string;
      dividendTaxableEur: string;
      note: string;
    };

    expect(result.year).toBe(2026);
    expect(result.taxableGainEur).toBe("0.00");
    expect(result.dividendTaxableEur).toBe("0.00");
    // The bracket depends on capital income the app cannot see, so there is no rate to reach for.
    expect(JSON.stringify(result)).not.toContain("30 %");
    expect(result).not.toHaveProperty("taxOwedEur");
  });

  test("answers for the current year when the ledger has no taxable event", async () => {
    const { tools } = await seed();
    // SAFETY: the tool's literal has this shape.
    const result = (await toolNamed(tools, "get_tax_year").run({})) as {
      year: number;
      availableYears: readonly number[];
    };

    expect(result.year).toBe(new Date().getUTCFullYear());
    expect(result.availableYears).toEqual([]);
  });
});

describe("get_drift", () => {
  test("reports the gap to target and never suggests a trade", () => {
    return (async () => {
      const { tools } = await seed();
      // SAFETY: the tool's literal has this shape.
      const result = (await toolNamed(tools, "get_drift").run({})) as {
        asOf: string;
        groupBy: string;
        totalEur: string;
        incomplete: boolean;
        rows: readonly { item: string; untargeted: boolean }[];
        note: string;
      };

      expect(result.groupBy).toBe("kind");
      expect(result.rows.every((row) => row.untargeted)).toBe(true);
      expect(result.note).toContain("You give no investment advice");
    })();
  });

  test("carries the fee report with withheld tax kept apart", async () => {
    const { tools } = await seed();
    // SAFETY: as above.
    const result = (await toolNamed(tools, "get_drift").run({})) as {
      fees: readonly { year: number; feesEur: string; withheldTaxEur: string }[];
    };

    // Kept as separate fields so an answer cannot add them.
    expect(result.fees).toEqual([]);
  });
});

describe("get_cash_flow", () => {
  test("splits a period into what came in, what went out, and what was left", async () => {
    const { tools, bankAccountId } = await seed();
    await receive(bankAccountId, "PALKKA — EXAMPLE OYJ", 300_000, "2026-03-01");
    await spend(bankAccountId, "PKORTTIMAKSU — K-MARKET EXAMPLE", -20_000, "2026-03-02");

    // SAFETY: the tool's literal has this shape.
    const result = (await toolNamed(tools, "get_cash_flow").run({
      from: "2026-03-01",
      to: "2026-03-31",
    })) as {
      incomeEur: string;
      spendingEur: string;
      leftoverEur: string;
      spentMoreThanEarned: boolean;
      byCategory: readonly { label: string; totalEur: string }[];
    };

    expect(result.incomeEur).toBe("3000.00");
    expect(result.spendingEur).toBe("200.00");
    expect(result.leftoverEur).toBe("2800.00");
    expect(result.spentMoreThanEarned).toBe(false);
    expect(result.byCategory[0]?.label).toBe("Groceries");
  });

  test("says so when the period spent more than it earned", async () => {
    const { tools, bankAccountId } = await seed();
    await receive(bankAccountId, "PALKKA — EXAMPLE OYJ", 10_000, "2026-04-01");
    await spend(bankAccountId, "PKORTTIMAKSU — K-MARKET EXAMPLE", -30_000, "2026-04-02");

    // SAFETY: as above.
    const result = (await toolNamed(tools, "get_cash_flow").run({
      from: "2026-04-01",
      to: "2026-04-30",
    })) as { leftoverEur: string; spentMoreThanEarned: boolean };

    // A positive figure with a flag: a negative "left over" reads as money in the account.
    expect(result.leftoverEur).toBe("200.00");
    expect(result.spentMoreThanEarned).toBe(true);
  });
});

describe("get_spending_trend", () => {
  test("gives a month per row so a trend can be seen without twelve calls", async () => {
    const { tools, bankAccountId } = await seed();
    await spend(bankAccountId, "PKORTTIMAKSU — K-MARKET EXAMPLE", -10_000, "2026-01-10");
    await spend(bankAccountId, "PKORTTIMAKSU — K-MARKET EXAMPLE", -20_000, "2026-02-10");

    // SAFETY: as above.
    const result = (await toolNamed(tools, "get_spending_trend").run({
      from: "2026-01-01",
      to: "2026-02-28",
    })) as { months: readonly { month: string; expensesEur: string }[] };

    expect(result.months.map((month) => month.month)).toEqual(["2026-01", "2026-02"]);
    expect(result.months[0]?.expensesEur).toBe("100.00");
    expect(result.months[1]?.expensesEur).toBe("200.00");
  });

  test("follows one category when asked for one", async () => {
    const { tools, bankAccountId } = await seed();
    await spend(bankAccountId, "PKORTTIMAKSU — K-MARKET EXAMPLE", -10_000, "2026-01-10");
    await spend(bankAccountId, "PKORTTIMAKSU — RAVINTOLA EXAMPLE", -5_000, "2026-01-11");

    // SAFETY: as above.
    const result = (await toolNamed(tools, "get_spending_trend").run({
      from: "2026-01-01",
      to: "2026-01-31",
      category: "groceries",
    })) as { category: string; label: string; months: readonly { totalEur: string }[] };

    expect(result.label).toBe("Groceries");
    expect(result.months[0]?.totalEur).toBe("100.00");
  });

  test("refuses a category that does not exist, naming the ones that do", async () => {
    const { tools } = await seed();

    expect(() =>
      toolNamed(tools, "get_spending_trend").schema.parse({ category: "kryptovaluutta" }),
    ).toThrow();
  });
});

describe("get_deposit_plan", () => {
  test("says where new money goes and never mentions selling", async () => {
    const { tools } = await seed();

    // SAFETY: as above.
    const result = (await toolNamed(tools, "get_deposit_plan").run({ amountEur: "1000.00" })) as {
      depositEur: string;
      allocations: readonly { label: string; amountEur: string }[];
      note: string;
    };

    expect(result.depositEur).toBe("1000.00");
    expect(result.allocations).toEqual([]);
    expect(result.note).toContain("No target");
  });

  test("splits the money toward the target once one is set", async () => {
    const { tools, userId } = await seed();
    const saved = await saveTargets(db, userId, "kind", [{ key: "fund", weightBp: 10_000 }]);
    expect(saved.ok).toBe(true);

    // SAFETY: as above.
    const result = (await toolNamed(tools, "get_deposit_plan").run({ amountEur: "500.00" })) as {
      allocations: readonly { label: string; amountEur: string }[];
      note: string;
    };

    expect(result.allocations).toHaveLength(1);
    expect(result.allocations[0]?.amountEur).toBe("500.00");
    // It may say where to buy, never what to sell.
    expect(result.note).toContain("You give no investment advice");
  });

  test("rejects an amount that is not money", async () => {
    const { tools } = await seed();
    const plan = toolNamed(tools, "get_deposit_plan");

    expect(() => plan.schema.parse({ amountEur: "a thousand euros" })).toThrow();
    expect(() => plan.schema.parse({ amountEur: "-500.00" })).toThrow();
  });
});

describe("get_transaction_class", () => {
  test("shows the class a row was given and why it was left out", async () => {
    const { tools, bankAccountId } = await seed();
    await spend(bankAccountId, "PKORTTIMAKSU — K-MARKET EXAMPLE", -4_215, "2026-05-01");
    await receive(bankAccountId, "PALKKA — EXAMPLE OYJ", 300_000, "2026-05-02");

    // SAFETY: as above.
    const result = (await toolNamed(tools, "get_transaction_class").run({
      from: "2026-05-01",
      to: "2026-05-31",
    })) as {
      transactions: readonly {
        text: string;
        categoryLabel: string;
        counted: boolean;
        excludedReason: string | null;
      }[];
    };

    const groceries = result.transactions.find((txn) => txn.text.includes("K-MARKET"));
    expect(groceries?.categoryLabel).toBe("Groceries");
    expect(groceries?.counted).toBe(true);

    const salary = result.transactions.find((txn) => txn.text.includes("PALKKA"));
    expect(salary?.counted).toBe(false);
    expect(salary?.excludedReason).toBe("income");
  });

  test("searches the text, so one payee can be asked about by name", async () => {
    const { tools, bankAccountId } = await seed();
    await spend(bankAccountId, "PKORTTIMAKSU — K-MARKET EXAMPLE", -4_215, "2026-05-01");
    await spend(bankAccountId, "PKORTTIMAKSU — LIDL HELSINKI", -3_120, "2026-05-02");

    // SAFETY: as above.
    const result = (await toolNamed(tools, "get_transaction_class").run({
      from: "2026-05-01",
      to: "2026-05-31",
      search: "lidl",
    })) as { count: number; transactions: readonly { text: string }[] };

    expect(result.count).toBe(1);
    expect(result.transactions[0]?.text).toContain("LIDL");
  });
});

// The only writing tools: classification, never the ledger, never a rule its owner wrote.
describe("save_spending_rules", () => {
  test("stores a rule for a payee the ledger actually holds", async () => {
    const { tools, bankAccountId } = await seed();
    await spend(bankAccountId, "PKORTTIMAKSU — OUTOKAUPPA OY", -2_500, "2026-07-01");

    // SAFETY: the tool's literal has this shape.
    const result = (await toolNamed(tools, "save_spending_rules").run({
      rules: [{ pattern: "OUTOKAUPPA", category: "groceries" }],
    })) as { added: readonly { pattern: string; label: string; matches: number }[] };

    expect(result.added).toHaveLength(1);
    expect(result.added[0]?.label).toBe("Groceries");
    expect(result.added[0]?.matches).toBe(1);

    // SAFETY: as above.
    const spending = (await toolNamed(tools, "get_spending").run({
      from: "2026-07-01",
      to: "2026-07-31",
    })) as { groups: readonly { label: string }[] };
    expect(spending.groups.some((group) => group.label === "Groceries")).toBe(true);
  });

  test("refuses a payee that is nowhere in the ledger", async () => {
    const { tools } = await seed();

    // A crafted statement line cannot get a rule for a merchant this ledger does not hold.
    // SAFETY: as above.
    const result = (await toolNamed(tools, "save_spending_rules").run({
      rules: [{ pattern: "KEKSITTY KAUPPA", category: "groceries" }],
    })) as { added: readonly unknown[]; skipped: readonly string[] };

    expect(result.added).toEqual([]);
    expect(result.skipped).toContain("KEKSITTY KAUPPA");
  });

  test("refuses a category the app does not have", async () => {
    const { tools } = await seed();

    expect(() =>
      toolNamed(tools, "save_spending_rules").schema.parse({
        rules: [{ pattern: "OUTOKAUPPA", category: "kryptovaluutta" }],
      }),
    ).toThrow();
  });
});

describe("update_spending_rule and remove_spending_rule", () => {
  test("corrects a rule it wrote itself", async () => {
    const { tools, bankAccountId } = await seed();
    await spend(bankAccountId, "PKORTTIMAKSU — OUTOKAUPPA OY", -2_500, "2026-07-01");
    await toolNamed(tools, "save_spending_rules").run({
      rules: [{ pattern: "OUTOKAUPPA", category: "groceries" }],
    });

    // SAFETY: as above.
    const result = (await toolNamed(tools, "update_spending_rule").run({
      pattern: "OUTOKAUPPA",
      category: "restaurants",
    })) as { changed: boolean; from: string; to: string };

    expect(result.changed).toBe(true);
    expect(result.from).toBe("Groceries");
    expect(result.to).toBe("Restaurants and cafes");
  });

  test("will not touch a rule the user wrote", async () => {
    const { tools, bankAccountId, userId } = await seed();
    await spend(bankAccountId, "PKORTTIMAKSU — OUTOKAUPPA OY", -2_500, "2026-07-01");
    await addRules(db, userId, [{ pattern: "OUTOKAUPPA", category: "groceries" }], "user");

    // SAFETY: as above.
    // SAFETY: as above.
    const changed = (await toolNamed(tools, "update_spending_rule").run({
      pattern: "OUTOKAUPPA",
      category: "restaurants",
    })) as { changed: boolean; reason: string };
    // SAFETY: as above.
    const removed = (await toolNamed(tools, "remove_spending_rule").run({
      pattern: "OUTOKAUPPA",
    })) as { removed: boolean; reason: string };

    expect(changed.changed).toBe(false);
    expect(changed.reason).toBe("owned-by-user");
    expect(removed.removed).toBe(false);
    expect(removed.reason).toBe("owned-by-user");
  });

  test("may repoint a built-in seed rule, which is not the user's own", async () => {
    const { tools } = await seed();

    // SAFETY: as above.
    const result = (await toolNamed(tools, "update_spending_rule").run({
      pattern: "K-MARKET",
      category: "leisure",
    })) as { changed: boolean; from: string };

    expect(result.changed).toBe(true);
    expect(result.from).toBe("Groceries");
  });

  test("reports a rule that is not there rather than inventing one", async () => {
    const { tools } = await seed();

    // SAFETY: as above.
    const result = (await toolNamed(tools, "remove_spending_rule").run({
      pattern: "NO SUCH RULE",
    })) as { removed: boolean; reason: string };

    expect(result.removed).toBe(false);
    expect(result.reason).toBe("no-such-rule");
  });
});

describe("get_spending_rules", () => {
  test("lists the rules and says which ones are the user's own", async () => {
    const { tools, userId } = await seed();
    await addRules(db, userId, [{ pattern: "OWN RULE", category: "home" }], "user");

    // SAFETY: as above.
    const result = (await toolNamed(tools, "get_spending_rules").run({ search: "OWN RULE" })) as {
      count: number;
      bySource: { user: number };
      rules: readonly { pattern: string; label: string; source: string }[];
    };

    expect(result.rules[0]?.pattern).toBe("OWN RULE");
    expect(result.rules[0]?.label).toBe("Home and renovation");
    expect(result.rules[0]?.source).toBe("user");
    expect(result.bySource.user).toBe(1);
  });
});

describe("get_reconciliation", () => {
  test("reports an account with no statement as unchecked, not as matching", async () => {
    const { tools } = await seed();

    // SAFETY: as above.
    const result = (await toolNamed(tools, "get_reconciliation").run({})) as {
      accounts: readonly { account: string; checkedAgainst: string | null; differences: number }[];
      unchecked: readonly string[];
      note: string;
    };

    // Zero differences with no snapshot means nothing was compared; it must not read as agreement.
    expect(result.accounts[0]?.checkedAgainst).toBeNull();
    expect(result.unchecked).toContain("Nordnet");
    expect(result.note).toContain("do not say it matches");
  });

  test("names the holdings whose derived quantity disagrees with the statement", async () => {
    const { tools, accountId, instrumentId } = await seed();
    await statement(accountId, instrumentId, 12, "2026-06-01");

    // SAFETY: as above.
    const result = (await toolNamed(tools, "get_reconciliation").run({})) as {
      accounts: readonly {
        account: string;
        checkedAgainst: string | null;
        differences: number;
        rows: readonly { name: string; derived: string; statement: string; delta: string }[];
      }[];
    };

    const checked = result.accounts.find((account) => account.checkedAgainst !== null);
    expect(checked?.checkedAgainst).toBe("2026-06-01");
    expect(checked?.differences).toBe(1);
    expect(checked?.rows[0]?.name).toBe("Testirahasto");
    expect(checked?.rows[0]?.derived).toBe("10.000000");
    expect(checked?.rows[0]?.statement).toBe("12.000000");
    expect(checked?.rows[0]?.delta).toBe("2.000000");
  });

  test("leaves bank accounts out, since a statement of holdings is not one", async () => {
    const { tools } = await seed();

    // SAFETY: as above.
    const result = (await toolNamed(tools, "get_reconciliation").run({})) as {
      accounts: readonly { account: string }[];
    };

    expect(result.accounts.map((account) => account.account)).not.toContain("OP current account");
  });
});

describe("get_recurring_payments", () => {
  test("finds a monthly bill and what it costs in a year", async () => {
    const { tools, bankAccountId } = await seed();
    for (const date of ["2026-04-05", "2026-05-05", "2026-06-05"]) {
      await spend(bankAccountId, "TILISIIRTO — SUORATOISTO OY", -1_299, date);
    }

    // SAFETY: as above.
    const result = (await toolNamed(tools, "get_recurring_payments").run({
      from: "2026-01-01",
      to: "2026-06-30",
    })) as {
      payments: readonly { payee: string; cadence: string; annualEur: string; active: boolean }[];
    };

    const found = result.payments.find((payment) => payment.payee === "SUORATOISTO OY");
    expect(found?.cadence).toBe("monthly");
    expect(found?.annualEur).toBe("155.88");
    expect(found?.active).toBe(true);
  });
});

describe("get_net_worth_series", () => {
  test("adds the bank balances the value series leaves out", async () => {
    const { tools, bankAccountId } = await seed();
    await receive(bankAccountId, "PALKKA — EXAMPLE OYJ", 50_000, "2026-01-03");

    // SAFETY: as above.
    const result = (await toolNamed(tools, "get_net_worth_series").run({
      from: "2026-01-01",
      to: "2026-06-01",
    })) as {
      points: readonly { date: string; positionsEur: string; cashEur: string; totalEur: string }[];
    };

    const last = result.points.at(-1);
    // Cash is every account's, not only the bank's, and none of it appears in get_value_series.
    expect(last?.positionsEur).toBe("120.00");
    expect(last?.cashEur).toBe("1400.00");
    expect(last?.totalEur).toBe("1520.00");
  });
});

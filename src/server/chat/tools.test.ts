import { beforeAll, describe, expect, test } from "bun:test";

import { EUR } from "../../core/money";

// The chat tools are the only thing standing between the model and a made-up
// number: the system prompt forbids arithmetic in prose, so whatever these
// return is what the user is told. These tests therefore assert on the exact
// strings, and on the two properties every result must carry -- the date it is
// good for, and whether any price behind it is stale.

let auth: (typeof import("../auth"))["auth"];
let accountRoutes: (typeof import("../api/accounts"))["accountRoutes"];
let instrumentRoutes: (typeof import("../api/instruments"))["instrumentRoutes"];
let buildChatTools: (typeof import("./tools"))["buildChatTools"];
let db: ReturnType<(typeof import("../db"))["getDb"]>["db"];
let transactions: (typeof import("../db/schema"))["transactions"];
let prices: (typeof import("../db/schema"))["prices"];

beforeAll(async () => {
  auth = (await import("../auth")).auth;
  accountRoutes = (await import("../api/accounts")).accountRoutes;
  instrumentRoutes = (await import("../api/instruments")).instrumentRoutes;
  buildChatTools = (await import("./tools")).buildChatTools;
  db = (await import("../db")).getDb().db;
  transactions = (await import("../db/schema")).transactions;
  prices = (await import("../db/schema")).prices;
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

const createAccount = async (cookie: string, name = "Nordnet"): Promise<number> => {
  const response = await accountRoutes["/api/accounts"].POST(
    new Request("http://x/api/accounts", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name, broker: "nordnet" }),
    }),
  );
  expect(response.status).toBe(201);
  // SAFETY: a 201 from POST /api/accounts always returns the inserted row.
  return ((await response.json()) as { id: number }).id;
};

/** A bank account, the only kind a statement's spending may land on. */
const createBankAccount = async (cookie: string): Promise<number> => {
  const response = await accountRoutes["/api/accounts"].POST(
    new Request("http://x/api/accounts", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        name: "OP käyttötili",
        broker: "op",
        kind: "bank",
        accountType: "current",
      }),
    }),
  );
  expect(response.status).toBe(201);
  // SAFETY: a 201 from POST /api/accounts always returns the inserted row.
  return ((await response.json()) as { id: number }).id;
};

const createInstrument = async (cookie: string, name: string): Promise<number> => {
  const response = await instrumentRoutes["/api/instruments"].POST(
    new Request("http://x/api/instruments", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        isin: randomIsin(),
        ticker: null,
        name,
        kind: "fund",
        currency: "EUR",
        priceSource: "manual",
      }),
    }),
  );
  expect(response.status).toBe(201);
  // SAFETY: as above.
  return ((await response.json()) as { id: number }).id;
};

/** 10 units at 10,00 EUR, so a later price of 12,00 makes the maths checkable by eye. */
const buy = (accountId: number, instrumentId: number, date: string): void => {
  db.insert(transactions)
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

const deposit = (accountId: number, date: string, minor: number): void => {
  db.insert(transactions)
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

/** One card payment on a bank account, as a statement import would write it. */
const spend = (accountId: number, note: string, minor: number, date: string): void => {
  db.insert(transactions)
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

const price = (instrumentId: number, date: string, minor: number): void => {
  db.insert(prices)
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

type Tools = ReturnType<typeof buildChatTools>;
const toolNamed = (tools: Tools, name: string): Tools[number] => {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`No tool named ${name}`);
  return tool;
};

/** One user, one account, one instrument bought at 10,00 and last priced at 12,00. */
const seed = async (): Promise<{
  tools: Tools;
  instrumentId: number;
  accountId: number;
  bankAccountId: number;
}> => {
  const { userId, cookie } = await signUp(`chat-${crypto.randomUUID()}@example.com`);
  const accountId = await createAccount(cookie);
  const bankAccountId = await createBankAccount(cookie);
  const instrumentId = await createInstrument(cookie, "Testirahasto");
  deposit(accountId, "2026-01-01", 100_000);
  buy(accountId, instrumentId, "2026-01-02");
  price(instrumentId, "2026-01-02", 1000);
  price(instrumentId, "2026-06-01", 1200);
  return { tools: buildChatTools(db, userId), instrumentId, accountId, bankAccountId };
};

describe("get_holdings", () => {
  test("reports quantity, cost and value as decimal strings for the asked date", async () => {
    const { tools } = await seed();
    // SAFETY: `run` returns this tool's own literal, whose shape is fixed a few
    // lines above in tools.ts; the assertion only names the fields read below.
    const result = toolNamed(tools, "get_holdings").run({ on: "2026-06-01" }) as {
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
    expect(() => toolNamed(tools, "get_holdings").run({ on: "1.6.2026" })).toThrow();
  });

  test("refuses an unknown argument, so a hallucinated parameter cannot pass silently", async () => {
    const { tools } = await seed();
    // The schema is what the SDK validates against before `run` is ever
    // called, so an invented parameter has to be refused there.
    expect(toolNamed(tools, "get_holdings").schema.safeParse({ userId: "someone" }).success).toBe(
      false,
    );
  });
});

describe("scoping", () => {
  test("sees only the calling user's own holdings", async () => {
    const { tools: mine } = await seed();
    await seed();
    // SAFETY: `run` returns this tool's own literal, whose shape is fixed a few
    // lines above in tools.ts; the assertion only names the fields read below.
    const result = mine.find((t) => t.name === "get_holdings")?.run({ on: "2026-06-01" }) as {
      holdings: unknown[];
    };
    // The other user's seed created its own instrument and transactions in the
    // same database; a leak would show up here as a second row.
    expect(result.holdings).toHaveLength(1);
  });

  test("names only instruments the user's own ledger references", async () => {
    const { tools: mine } = await seed();
    // The registry is shared, so the other user's fund exists in the same table.
    await seed();
    // SAFETY: `run` returns this tool's own literal, whose shape is fixed a few
    // lines above in tools.ts; the assertion only names the fields read below.
    const result = toolNamed(mine, "get_instruments").run({}) as { instruments: unknown[] };
    expect(result.instruments).toHaveLength(1);
  });
});

describe("get_cash", () => {
  test("reports the deposit that has not been invested, per account", async () => {
    const { tools } = await seed();
    // SAFETY: `run` returns this tool's own literal, whose shape is fixed a few
    // lines above in tools.ts; the assertion only names the fields read below.
    const result = toolNamed(tools, "get_cash").run({ on: "2026-06-01" }) as {
      asOf: string;
      totalEur: string;
      balances: Array<{ account: string; currency: string; amount: string }>;
    };

    // The seed deposits 1000,00 and spends 100,00 on the holding.
    expect(result.asOf).toBe("2026-06-01");
    expect(result.totalEur).toBe("900.00");
    expect(result.balances).toEqual([
      expect.objectContaining({ account: "Nordnet", currency: "EUR", amount: "900.00" }),
    ]);
  });

  test("get_holdings names the same cash total, so worth needs no arithmetic in prose", async () => {
    const { tools } = await seed();
    // SAFETY: as above.
    const holdings = toolNamed(tools, "get_holdings").run({ on: "2026-06-01" }) as {
      cashEur: string;
    };
    expect(holdings.cashEur).toBe("900.00");
  });
});

describe("get_allocation", () => {
  test("splits by the requested dimension and totals to one", async () => {
    const { tools } = await seed();
    // SAFETY: `run` returns this tool's own literal, whose shape is fixed a few
    // lines above in tools.ts; the assertion only names the fields read below.
    const result = toolNamed(tools, "get_allocation").run({
      on: "2026-06-01",
      dimension: "currency",
    }) as { dimension: string; slices: Array<{ label: string; valueEur: string; weight: number }> };

    expect(result.dimension).toBe("currency");
    // 120,00 of holding plus the 900,00 the deposit left uninvested: cash is
    // part of the allocation (spec 10e/E1), so the chat and the dashboard agree.
    expect(result.slices).toEqual([{ label: "EUR", valueEur: "1020.00", weight: 1 }]);
  });
});

describe("get_returns", () => {
  test("returns twr and mwr, and says which period they cover", async () => {
    const { tools } = await seed();
    // SAFETY: `run` returns this tool's own literal, whose shape is fixed a few
    // lines above in tools.ts; the assertion only names the fields read below.
    const result = toolNamed(tools, "get_returns").run({
      from: "2026-01-01",
      to: "2026-06-01",
    }) as { from: string; to: string; valueEur: string; twr: number | null; mwr: number | null };

    expect(result.from).toBe("2026-01-01");
    expect(result.to).toBe("2026-06-01");
    expect(result.valueEur).toBe("120.00");
    // 100,00 -> 120,00 with no flows in between.
    expect(result.twr).toBeCloseTo(0.2, 6);
    expect(result.mwr).not.toBeNull();
  });
});

describe("get_value_series", () => {
  test("thins a long period instead of truncating it, keeping both ends", async () => {
    const { tools } = await seed();
    // SAFETY: `run` returns this tool's own literal, whose shape is fixed a few
    // lines above in tools.ts; the assertion only names the fields read below.
    const result = toolNamed(tools, "get_value_series").run({
      from: "2026-01-01",
      to: "2026-06-01",
    }) as { points: Array<{ date: string; valueEur: string }> };

    expect(result.points.length).toBeLessThanOrEqual(60);
    expect(result.points[0]?.date).toBe("2026-01-01");
    expect(result.points.at(-1)?.date).toBe("2026-06-01");
    expect(result.points.at(-1)?.valueEur).toBe("120.00");
  });
});

describe("get_transactions", () => {
  test("returns newest first and says when the answer was cut short", async () => {
    const { tools } = await seed();
    // SAFETY: `run` returns this tool's own literal, whose shape is fixed a few
    // lines above in tools.ts; the assertion only names the fields read below.
    const result = toolNamed(tools, "get_transactions").run({ limit: 1 }) as {
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
    // SAFETY: `run` returns this tool's own literal, whose shape is fixed a few
    // lines above in tools.ts; the assertion only names the fields read below.
    const result = toolNamed(tools, "get_value_series").run({
      from: "2020-01-01",
      to: "2026-06-01",
    }) as { points: Array<{ date: string }> };

    expect(result.points.length).toBeLessThanOrEqual(60);
    expect(result.points.at(-1)?.date).toBe("2026-06-01");
  });

  test("returns 25 transactions by default and says the answer was cut short", async () => {
    const { tools, accountId, instrumentId } = await seed();
    for (let day = 1; day <= 28; day += 1) {
      buy(accountId, instrumentId, `2026-03-${String(day).padStart(2, "0")}`);
    }
    // SAFETY: as above.
    const result = toolNamed(tools, "get_transactions").run({}) as {
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
    spend(bankAccountId, "PKORTTIMAKSU — K-MARKET ESIMERKKI", -4215, "2026-03-01");
    spend(bankAccountId, "PKORTTIMAKSU — LIDL HELSINKI", -3120, "2026-03-02");
    spend(bankAccountId, "PKORTTIMAKSU — RAVINTOLA ESIMERKKI", -1850, "2026-03-03");

    // SAFETY: `run` returns this tool's own literal, whose shape is fixed a few
    // lines above in tools.ts; the assertion only names the fields read below.
    const result = toolNamed(tools, "get_spending").run({
      from: "2026-01-01",
      to: "2026-12-31",
    }) as {
      totalEur: string;
      groups: Array<{ label: string; totalEur: string; count: number }>;
      uncategorisedShare: number;
    };

    const food = result.groups.find((group) => group.label === "Ruokakauppa");
    expect(food?.totalEur).toBe("-73.35");
    expect(food?.count).toBe(2);
    expect(result.totalEur).toBe("-91.85");
    expect(result.uncategorisedShare).toBe(0);
  });

  test("groups by counterparty when asked", async () => {
    const { tools, bankAccountId } = await seed();
    spend(bankAccountId, "PKORTTIMAKSU — K-MARKET ESIMERKKI", -4215, "2026-03-01");
    spend(bankAccountId, "PKORTTIMAKSU — K-MARKET ESIMERKKI", -1785, "2026-03-02");

    // SAFETY: as above.
    const result = toolNamed(tools, "get_spending").run({
      from: "2026-01-01",
      to: "2026-12-31",
      groupBy: "counterparty",
    }) as { groups: Array<{ label: string; totalEur: string }> };

    expect(result.groups[0]?.label).toBe("K-MARKET ESIMERKKI");
    expect(result.groups[0]?.totalEur).toBe("-60.00");
  });
});

describe("get_uncategorised_spending", () => {
  test("names the merchants no rule matched, so the model can propose a class", async () => {
    const { tools, bankAccountId } = await seed();
    spend(bankAccountId, "PKORTTIMAKSU — K-MARKET ESIMERKKI", -4215, "2026-03-01");
    spend(bankAccountId, "PKORTTIMAKSU — JOKIN TUNTEMATON LIIKE", -1000, "2026-03-02");
    spend(bankAccountId, "PKORTTIMAKSU — JOKIN TUNTEMATON LIIKE", -500, "2026-03-03");

    // SAFETY: `run` returns this tool's own literal, whose shape is fixed a few
    // lines above in tools.ts; the assertion only names the fields read below.
    const result = toolNamed(tools, "get_uncategorised_spending").run({
      from: "2026-01-01",
      to: "2026-12-31",
    }) as { totalEur: string; merchants: Array<{ name: string; totalEur: string; count: number }> };

    // The recognised grocery shop is not here; the unknown one is, summed.
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
    const result = toolNamed(tools, "calculate").run({
      operation: "sum",
      values: ["0.10", "0.20"],
    }) as { result: string; working: string };

    expect(result.result).toBe("0.30");
    expect(result.working).toBe("0.10 + 0.20 = 0.30");
  });

  test("returns a bad calculation as a message the model can act on", async () => {
    const { tools } = await seed();
    // SAFETY: as above.
    const result = toolNamed(tools, "calculate").run({
      operation: "divide",
      values: ["10.00", "0"],
    }) as { error?: string };

    // A thrown tool kills the turn; a message lets the model say what happened.
    expect(result.error).toContain("Nollalla");
  });
});

describe("get_instruments", () => {
  test("lists the registered instruments", async () => {
    const { tools } = await seed();
    // SAFETY: `run` returns this tool's own literal, whose shape is fixed a few
    // lines above in tools.ts; the assertion only names the fields read below.
    const result = toolNamed(tools, "get_instruments").run({}) as {
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
    // SAFETY: `run` returns this tool's own literal, whose shape is fixed in
    // tools.ts; the assertion only names the fields read below.
    const result = toolNamed(tools, "get_tax_year").run({ year: 2026 }) as {
      year: number;
      availableYears: readonly number[];
      taxableGainEur: string;
      dividendTaxableEur: string;
      note: string;
    };

    expect(result.year).toBe(2026);
    expect(result.taxableGainEur).toBe("0.00");
    expect(result.dividendTaxableEur).toBe("0.00");
    // The bracket depends on capital income the app cannot see, so a chat
    // answer must have no rate to reach for either.
    expect(JSON.stringify(result)).not.toContain("30 %");
    expect(result).not.toHaveProperty("taxOwedEur");
  });

  test("answers for the current year when the ledger has no taxable event", async () => {
    const { tools } = await seed();
    // SAFETY: `run` returns this tool's own literal, whose shape is fixed in
    // tools.ts; the assertion only names the fields read below.
    const result = toolNamed(tools, "get_tax_year").run({}) as {
      year: number;
      availableYears: readonly number[];
    };

    // An empty report is the true answer, and availableYears says which years
    // hold anything -- better than refusing to answer at all.
    expect(result.year).toBe(new Date().getUTCFullYear());
    expect(result.availableYears).toEqual([]);
  });
});

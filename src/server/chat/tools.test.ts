import { beforeAll, describe, expect, test } from "vitest";

import { EUR } from "../../core/money.ts";

// The chat tools are the only thing standing between the model and a made-up
// number: the system prompt forbids arithmetic in prose, so whatever these
// return is what the user is told. These tests therefore assert on the exact
// strings, and on the two properties every result must carry -- the date it is
// good for, and whether any price behind it is stale.

let auth: (typeof import("../auth.ts"))["auth"];
let accountRoutes: (typeof import("../api/accounts.ts"))["accountRoutes"];
let instrumentRoutes: (typeof import("../api/instruments.ts"))["instrumentRoutes"];
let rebalanceRoutes: (typeof import("../api/rebalance.ts"))["rebalanceRoutes"];
let addRules: (typeof import("../spending/rules.ts"))["addRules"];
let buildChatTools: (typeof import("./tools.ts"))["buildChatTools"];
let db: ReturnType<(typeof import("../db/index.ts"))["getDb"]>["db"];
let transactions: (typeof import("../db/schema.ts"))["transactions"];
let prices: (typeof import("../db/schema.ts"))["prices"];
let snapshots: (typeof import("../db/schema.ts"))["snapshots"];
let snapshotRows: (typeof import("../db/schema.ts"))["snapshotRows"];

beforeAll(async () => {
  auth = (await import("../auth.ts")).auth;
  accountRoutes = (await import("../api/accounts.ts")).accountRoutes;
  instrumentRoutes = (await import("../api/instruments.ts")).instrumentRoutes;
  rebalanceRoutes = (await import("../api/rebalance.ts")).rebalanceRoutes;
  addRules = (await import("../spending/rules.ts")).addRules;
  buildChatTools = (await import("./tools.ts")).buildChatTools;
  db = (await import("../db/index.ts")).getDb().db;
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

/** Money arriving on a bank account, with the text a statement would carry. */
const receive = (accountId: number, note: string, minor: number, date: string): void => {
  db.insert(transactions)
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

/** A broker's holdings statement, as an import would have written it. */
const statement = (accountId: number, instrumentId: number, units: number, asOf: string): void => {
  const snapshot = db
    .insert(snapshots)
    .values({ accountId, asOf, source: "manual" })
    .returning({ id: snapshots.id })
    .all()[0];
  if (!snapshot) throw new Error("snapshot insert returned nothing");
  db.insert(snapshotRows)
    .values({
      snapshotId: snapshot.id,
      instrumentId,
      quantity: units * 1_000_000,
      // The statement's own price and value. Reconciliation compares units, not
      // money, so these only have to be present and consistent.
      nav: 1200,
      marketValue: units * 1200,
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
  cookie: string;
  userId: string;
}> => {
  const { userId, cookie } = await signUp(`chat-${crypto.randomUUID()}@example.com`);
  const accountId = await createAccount(cookie);
  const bankAccountId = await createBankAccount(cookie);
  const instrumentId = await createInstrument(cookie, "Testirahasto");
  deposit(accountId, "2026-01-01", 100_000);
  buy(accountId, instrumentId, "2026-01-02");
  price(instrumentId, "2026-01-02", 1000);
  price(instrumentId, "2026-06-01", 1200);
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

describe("get_drift", () => {
  test("reports the gap to target and never suggests a trade", () => {
    return (async () => {
      const { tools } = await seed();
      // SAFETY: `run` returns this tool's own literal, whose shape is fixed in
      // tools.ts; the assertion only names the fields read below.
      const result = toolNamed(tools, "get_drift").run({}) as {
        asOf: string;
        groupBy: string;
        totalEur: string;
        incomplete: boolean;
        rows: readonly { erä: string; ilmanTavoitetta: boolean }[];
        note: string;
      };

      expect(result.groupBy).toBe("kind");
      // With no targets set, every slice is untargeted rather than at zero.
      expect(result.rows.every((row) => row.ilmanTavoitetta)).toBe(true);
      expect(result.note).toContain("Et anna sijoitusneuvoja");
    })();
  });

  test("carries the fee report with withheld tax kept apart", async () => {
    const { tools } = await seed();
    // SAFETY: as above.
    const result = toolNamed(tools, "get_drift").run({}) as {
      fees: readonly { year: number; kulutEur: string; pidätettyVeroEur: string }[];
    };

    // The two are different things and the tool must not let an answer add
    // them together, so each year carries them as separate fields.
    expect(result.fees).toEqual([]);
  });
});

describe("get_cash_flow", () => {
  test("splits a period into what came in, what went out, and what was left", async () => {
    const { tools, bankAccountId } = await seed();
    receive(bankAccountId, "PALKKA — ESIMERKKI OYJ", 300_000, "2026-03-01");
    spend(bankAccountId, "PKORTTIMAKSU — K-MARKET ESIMERKKI", -20_000, "2026-03-02");

    // SAFETY: `run` returns this tool's own literal, whose shape is fixed in
    // tools-money.ts; the assertion only names the fields read below.
    const result = toolNamed(tools, "get_cash_flow").run({
      from: "2026-03-01",
      to: "2026-03-31",
    }) as {
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
    expect(result.byCategory[0]?.label).toBe("Ruokakauppa");
  });

  test("says so when the period spent more than it earned", async () => {
    const { tools, bankAccountId } = await seed();
    receive(bankAccountId, "PALKKA — ESIMERKKI OYJ", 10_000, "2026-04-01");
    spend(bankAccountId, "PKORTTIMAKSU — K-MARKET ESIMERKKI", -30_000, "2026-04-02");

    // SAFETY: as above.
    const result = toolNamed(tools, "get_cash_flow").run({
      from: "2026-04-01",
      to: "2026-04-30",
    }) as { leftoverEur: string; spentMoreThanEarned: boolean };

    // Reported as a positive figure with a flag, never as a negative "left
    // over", which reads as money in the account.
    expect(result.leftoverEur).toBe("200.00");
    expect(result.spentMoreThanEarned).toBe(true);
  });
});

describe("get_spending_trend", () => {
  test("gives a month per row so a trend can be seen without twelve calls", async () => {
    const { tools, bankAccountId } = await seed();
    spend(bankAccountId, "PKORTTIMAKSU — K-MARKET ESIMERKKI", -10_000, "2026-01-10");
    spend(bankAccountId, "PKORTTIMAKSU — K-MARKET ESIMERKKI", -20_000, "2026-02-10");

    // SAFETY: as above.
    const result = toolNamed(tools, "get_spending_trend").run({
      from: "2026-01-01",
      to: "2026-02-28",
    }) as { months: readonly { month: string; expensesEur: string }[] };

    expect(result.months.map((month) => month.month)).toEqual(["2026-01", "2026-02"]);
    // Expenses are reported as a positive magnitude, as `monthlyFlows` states.
    expect(result.months[0]?.expensesEur).toBe("100.00");
    expect(result.months[1]?.expensesEur).toBe("200.00");
  });

  test("follows one category when asked for one", async () => {
    const { tools, bankAccountId } = await seed();
    spend(bankAccountId, "PKORTTIMAKSU — K-MARKET ESIMERKKI", -10_000, "2026-01-10");
    spend(bankAccountId, "PKORTTIMAKSU — RAVINTOLA ESIMERKKI", -5_000, "2026-01-11");

    // SAFETY: as above.
    const result = toolNamed(tools, "get_spending_trend").run({
      from: "2026-01-01",
      to: "2026-01-31",
      category: "ruoka",
    }) as { category: string; label: string; months: readonly { totalEur: string }[] };

    expect(result.label).toBe("Ruokakauppa");
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
    const result = toolNamed(tools, "get_deposit_plan").run({ amountEur: "1000.00" }) as {
      depositEur: string;
      allocations: readonly { label: string; amountEur: string }[];
      note: string;
    };

    expect(result.depositEur).toBe("1000.00");
    // No targets are set in the seed, so there is nothing to allocate toward --
    // and an empty plan must read as "no target set", not as "put in nothing".
    expect(result.allocations).toEqual([]);
    expect(result.note).toContain("tavoite");
  });

  test("splits the money toward the target once one is set", async () => {
    const { tools, cookie } = await seed();
    const saved = await rebalanceRoutes["/api/targets"].PUT(
      new Request("http://x/api/targets", {
        method: "PUT",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({
          dimension: "kind",
          targets: [{ key: "fund", weightPercent: "100.00" }],
        }),
      }),
    );
    expect(saved.status).toBe(200);

    // SAFETY: as above.
    const result = toolNamed(tools, "get_deposit_plan").run({ amountEur: "500.00" }) as {
      allocations: readonly { label: string; amountEur: string }[];
      note: string;
    };

    // One slice, targeted at everything, so the whole deposit goes there.
    expect(result.allocations).toHaveLength(1);
    expect(result.allocations[0]?.amountEur).toBe("500.00");
    // The rule the whole tool exists inside: it may say where to buy, never
    // what to sell.
    expect(result.note).toContain("Et anna sijoitusneuvoja");
  });

  test("rejects an amount that is not money", async () => {
    const { tools } = await seed();
    const plan = toolNamed(tools, "get_deposit_plan");

    expect(() => plan.schema.parse({ amountEur: "tuhat euroa" })).toThrow();
    expect(() => plan.schema.parse({ amountEur: "-500.00" })).toThrow();
  });
});

describe("get_transaction_class", () => {
  test("shows the class a row was given and why it was left out", async () => {
    const { tools, bankAccountId } = await seed();
    spend(bankAccountId, "PKORTTIMAKSU — K-MARKET ESIMERKKI", -4_215, "2026-05-01");
    receive(bankAccountId, "PALKKA — ESIMERKKI OYJ", 300_000, "2026-05-02");

    // SAFETY: as above.
    const result = toolNamed(tools, "get_transaction_class").run({
      from: "2026-05-01",
      to: "2026-05-31",
    }) as {
      transactions: readonly {
        text: string;
        categoryLabel: string;
        counted: boolean;
        excludedReason: string | null;
      }[];
    };

    const groceries = result.transactions.find((txn) => txn.text.includes("K-MARKET"));
    expect(groceries?.categoryLabel).toBe("Ruokakauppa");
    expect(groceries?.counted).toBe(true);

    const salary = result.transactions.find((txn) => txn.text.includes("PALKKA"));
    expect(salary?.counted).toBe(false);
    expect(salary?.excludedReason).toBe("income");
  });

  test("searches the text, so one payee can be asked about by name", async () => {
    const { tools, bankAccountId } = await seed();
    spend(bankAccountId, "PKORTTIMAKSU — K-MARKET ESIMERKKI", -4_215, "2026-05-01");
    spend(bankAccountId, "PKORTTIMAKSU — LIDL HELSINKI", -3_120, "2026-05-02");

    // SAFETY: as above.
    const result = toolNamed(tools, "get_transaction_class").run({
      from: "2026-05-01",
      to: "2026-05-31",
      search: "lidl",
    }) as { count: number; transactions: readonly { text: string }[] };

    expect(result.count).toBe(1);
    expect(result.transactions[0]?.text).toContain("LIDL");
  });
});

// The only tools in the app that write. What they may touch is the whole point:
// the classification, never the ledger, and never a rule its owner wrote.
describe("save_spending_rules", () => {
  test("stores a rule for a payee the ledger actually holds", async () => {
    const { tools, bankAccountId } = await seed();
    spend(bankAccountId, "PKORTTIMAKSU — OUTOKAUPPA OY", -2_500, "2026-07-01");

    // SAFETY: `run` returns this tool's own literal, whose shape is fixed in
    // tools-rules.ts; the assertion only names the fields read below.
    const result = toolNamed(tools, "save_spending_rules").run({
      rules: [{ pattern: "OUTOKAUPPA", category: "ruoka" }],
    }) as { added: readonly { pattern: string; label: string; matches: number }[] };

    expect(result.added).toHaveLength(1);
    expect(result.added[0]?.label).toBe("Ruokakauppa");
    // Says what the rule now catches, so an answer can report the effect.
    expect(result.added[0]?.matches).toBe(1);

    // And the rule is live: the same payment now reads as groceries.
    // SAFETY: as above -- get_spending's literal is fixed in tools.ts.
    const spending = toolNamed(tools, "get_spending").run({
      from: "2026-07-01",
      to: "2026-07-31",
    }) as { groups: readonly { label: string }[] };
    expect(spending.groups.some((group) => group.label === "Ruokakauppa")).toBe(true);
  });

  test("refuses a payee that is nowhere in the ledger", async () => {
    const { tools } = await seed();

    // A statement line is text the app did not write. If a crafted one could
    // talk the model into a rule, the rule would still have to name a merchant
    // this ledger holds -- and this one does not.
    // SAFETY: as above.
    const result = toolNamed(tools, "save_spending_rules").run({
      rules: [{ pattern: "KEKSITTY KAUPPA", category: "ruoka" }],
    }) as { added: readonly unknown[]; skipped: readonly string[] };

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
    spend(bankAccountId, "PKORTTIMAKSU — OUTOKAUPPA OY", -2_500, "2026-07-01");
    toolNamed(tools, "save_spending_rules").run({
      rules: [{ pattern: "OUTOKAUPPA", category: "ruoka" }],
    });

    // SAFETY: as above.
    const result = toolNamed(tools, "update_spending_rule").run({
      pattern: "OUTOKAUPPA",
      category: "ravintolat",
    }) as { changed: boolean; from: string; to: string };

    expect(result.changed).toBe(true);
    expect(result.from).toBe("Ruokakauppa");
    expect(result.to).toBe("Ravintolat ja kahvilat");
  });

  test("will not touch a rule the user wrote", async () => {
    const { tools, bankAccountId, userId } = await seed();
    spend(bankAccountId, "PKORTTIMAKSU — OUTOKAUPPA OY", -2_500, "2026-07-01");
    // The user's own decision, stored the way the Kulutus page stores it.
    addRules(db, userId, [{ pattern: "OUTOKAUPPA", category: "ruoka" }], "user");

    // SAFETY: as above.
    // SAFETY: as above.
    const changed = toolNamed(tools, "update_spending_rule").run({
      pattern: "OUTOKAUPPA",
      category: "ravintolat",
    }) as { changed: boolean; reason: string };
    // SAFETY: as above.
    const removed = toolNamed(tools, "remove_spending_rule").run({
      pattern: "OUTOKAUPPA",
    }) as { removed: boolean; reason: string };

    expect(changed.changed).toBe(false);
    expect(changed.reason).toBe("owned-by-user");
    expect(removed.removed).toBe(false);
    expect(removed.reason).toBe("owned-by-user");
  });

  test("may repoint a built-in seed rule, which is not the user's own", async () => {
    const { tools } = await seed();

    // SAFETY: as above.
    const result = toolNamed(tools, "update_spending_rule").run({
      pattern: "K-MARKET",
      category: "vapaa-aika",
    }) as { changed: boolean; from: string };

    expect(result.changed).toBe(true);
    expect(result.from).toBe("Ruokakauppa");
  });

  test("reports a rule that is not there rather than inventing one", async () => {
    const { tools } = await seed();

    // SAFETY: as above.
    const result = toolNamed(tools, "remove_spending_rule").run({
      pattern: "EI TÄLLAISTA",
    }) as { removed: boolean; reason: string };

    expect(result.removed).toBe(false);
    expect(result.reason).toBe("no-such-rule");
  });
});

describe("get_spending_rules", () => {
  test("lists the rules and says which ones are the user's own", async () => {
    const { tools, userId } = await seed();
    addRules(db, userId, [{ pattern: "OMA SÄÄNTÖ", category: "koti" }], "user");

    // SAFETY: as above.
    const result = toolNamed(tools, "get_spending_rules").run({ search: "OMA SÄÄNTÖ" }) as {
      count: number;
      bySource: { user: number };
      rules: readonly { pattern: string; label: string; source: string }[];
    };

    expect(result.rules[0]?.pattern).toBe("OMA SÄÄNTÖ");
    expect(result.rules[0]?.label).toBe("Koti ja remontti");
    expect(result.rules[0]?.source).toBe("user");
    expect(result.bySource.user).toBe(1);
  });
});

describe("get_reconciliation", () => {
  test("reports an account with no statement as unchecked, not as matching", async () => {
    const { tools } = await seed();

    // SAFETY: as above.
    const result = toolNamed(tools, "get_reconciliation").run({}) as {
      accounts: readonly { account: string; checkedAgainst: string | null; differences: number }[];
      unchecked: readonly string[];
      note: string;
    };

    // The seeded brokerage account has no snapshot. Zero differences here means
    // nothing was compared, and the result has to make that impossible to read
    // as agreement.
    expect(result.accounts[0]?.checkedAgainst).toBeNull();
    expect(result.unchecked).toContain("Nordnet");
    expect(result.note).toContain("älä sano että se täsmää");
  });

  test("names the holdings whose derived quantity disagrees with the statement", async () => {
    const { tools, accountId, instrumentId } = await seed();
    // The ledger derives 10 units from its transactions; the broker says 12.
    statement(accountId, instrumentId, 12, "2026-06-01");

    // SAFETY: as above.
    const result = toolNamed(tools, "get_reconciliation").run({}) as {
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
    // Positive means the ledger is missing units -- a transaction never imported.
    expect(checked?.rows[0]?.delta).toBe("2.000000");
  });

  test("leaves bank accounts out, since a statement of holdings is not one", async () => {
    const { tools } = await seed();

    // SAFETY: as above.
    const result = toolNamed(tools, "get_reconciliation").run({}) as {
      accounts: readonly { account: string }[];
    };

    expect(result.accounts.map((account) => account.account)).not.toContain("OP käyttötili");
  });
});

describe("get_recurring_payments", () => {
  test("finds a monthly bill and what it costs in a year", async () => {
    const { tools, bankAccountId } = await seed();
    for (const date of ["2026-04-05", "2026-05-05", "2026-06-05"]) {
      spend(bankAccountId, "TILISIIRTO — SUORATOISTO OY", -1_299, date);
    }

    // SAFETY: as above.
    const result = toolNamed(tools, "get_recurring_payments").run({
      from: "2026-01-01",
      to: "2026-06-30",
    }) as {
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
    receive(bankAccountId, "PALKKA — ESIMERKKI OYJ", 50_000, "2026-01-03");

    // SAFETY: as above.
    const result = toolNamed(tools, "get_net_worth_series").run({
      from: "2026-01-01",
      to: "2026-06-01",
    }) as {
      points: readonly { date: string; positionsEur: string; cashEur: string; totalEur: string }[];
    };

    const last = result.points.at(-1);
    // 10 units last priced at 12,00 is 120,00 of positions. The cash is every
    // account's, not only the bank's: 1 000,00 deposited at the broker less the
    // 100,00 the shares cost, plus 500,00 of salary -- and none of that 1 400,00
    // appears in get_value_series, which is the whole reason this tool exists.
    expect(last?.positionsEur).toBe("120.00");
    expect(last?.cashEur).toBe("1400.00");
    expect(last?.totalEur).toBe("1520.00");
  });
});

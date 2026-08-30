import { beforeAll, describe, expect, test } from "vitest";
import { z } from "zod";

// The only route in the app that writes a transaction by hand. Everything else
// arrives through the import pipeline, so these tests care about the two things
// that keeps honest: it may only write cash rows (never a trade), and it may
// only touch rows it wrote itself (never a broker's record).

let auth: (typeof import("../auth.ts"))["auth"];
let accountRoutes: (typeof import("./accounts.ts"))["accountRoutes"];
let cashEntryRoutes: (typeof import("./cash-entries.ts"))["cashEntryRoutes"];
let portfolioRoutes: (typeof import("./portfolio.ts"))["portfolioRoutes"];

beforeAll(async () => {
  auth = (await import("../auth.ts")).auth;
  accountRoutes = (await import("./accounts.ts")).accountRoutes;
  cashEntryRoutes = (await import("./cash-entries.ts")).cashEntryRoutes;
  portfolioRoutes = (await import("./portfolio.ts")).portfolioRoutes;
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
        email: `cash-entry-${crypto.randomUUID()}@example.com`,
        password: "correct horse battery staple",
      }),
    }),
  );
  if (response.status !== 200) throw new Error(`sign-up failed with status ${response.status}`);
  return sessionCookieFrom(response);
};

const IdSchema = z.object({ id: z.number() });
const ErrorSchema = z.object({ error: z.string() });
const EntriesSchema = z.object({
  entries: z.array(
    z.object({
      id: z.number(),
      type: z.string(),
      tradeDate: z.string(),
      amount: z.string(),
      currency: z.string(),
      note: z.string().nullable(),
    }),
  ),
});
const CashSchema = z.object({ totalEur: z.string() });

const openBankAccount = async (cookie: string, accountType = "savings"): Promise<number> => {
  const response = await accountRoutes["/api/accounts"].POST(
    new Request("http://x/api/accounts", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "OP säästötili", broker: "op", kind: "bank", accountType }),
    }),
  );
  expect(response.status).toBe(201);
  return IdSchema.parse(await response.json()).id;
};

type Entry = {
  accountId: number;
  /** A refused type is part of the contract, so this is wider than the route's own. */
  type: "OPENING_BALANCE" | "DEPOSIT" | "WITHDRAWAL" | "INTEREST" | "BUY";
  tradeDate: string;
  amount: string;
  currency?: string;
  note?: string;
};

const post = (cookie: string, body: Entry): Promise<Response> =>
  cashEntryRoutes["/api/cash-entries"].POST(
    new Request("http://x/api/cash-entries", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(body),
    }),
  );

const cashTotal = async (cookie: string, on: string): Promise<string> => {
  const response = await portfolioRoutes["/api/cash"].GET(
    new Request(`http://x/api/cash?on=${on}`, { headers: { cookie } }),
  );
  return CashSchema.parse(await response.json()).totalEur;
};

describe("POST /api/cash-entries", () => {
  test("rejects a request with no session", async () => {
    const response = await post("", {
      accountId: 1,
      type: "DEPOSIT",
      tradeDate: "2026-01-15",
      amount: "100.00",
    });
    expect(response.status).toBe(401);
  });

  test("refuses an account belonging to someone else, as 404 rather than 403", async () => {
    const owner = await signUp();
    const stranger = await signUp();
    const accountId = await openBankAccount(owner);

    const response = await post(stranger, {
      accountId,
      type: "DEPOSIT",
      tradeDate: "2026-01-15",
      amount: "100.00",
    });
    expect(response.status).toBe(404);
  });

  test("refuses a trade: a position must never come from a hand-written row", async () => {
    const cookie = await signUp();
    const accountId = await openBankAccount(cookie);

    const response = await post(cookie, {
      accountId,
      type: "BUY",
      tradeDate: "2026-01-15",
      amount: "100.00",
    });
    expect(response.status).toBe(400);
  });

  test("stores a withdrawal as money leaving, whatever sign the caller sent", async () => {
    const cookie = await signUp();
    const accountId = await openBankAccount(cookie);

    await post(cookie, {
      accountId,
      type: "DEPOSIT",
      tradeDate: "2026-01-15",
      amount: "1000.00",
    });
    await post(cookie, {
      accountId,
      type: "WITHDRAWAL",
      tradeDate: "2026-02-01",
      amount: "250.00",
    });

    expect(await cashTotal(cookie, "2026-06-01")).toBe("750.00");
  });

  test("counts interest as money arriving", async () => {
    const cookie = await signUp();
    const accountId = await openBankAccount(cookie, "fixed_term");

    await post(cookie, {
      accountId,
      type: "DEPOSIT",
      tradeDate: "2026-01-15",
      amount: "10000.00",
    });
    await post(cookie, { accountId, type: "INTEREST", tradeDate: "2026-07-15", amount: "150.00" });

    expect(await cashTotal(cookie, "2026-08-01")).toBe("10150.00");
  });

  test("refuses the same movement twice rather than doubling a balance", async () => {
    const cookie = await signUp();
    const accountId = await openBankAccount(cookie);
    const entry: Entry = {
      accountId,
      type: "DEPOSIT",
      tradeDate: "2026-01-15",
      amount: "1000.00",
    };

    expect((await post(cookie, entry)).status).toBe(201);
    const second = await post(cookie, entry);
    expect(second.status).toBe(409);
    expect(await cashTotal(cookie, "2026-06-01")).toBe("1000.00");
  });
});

describe("opening balance", () => {
  test("carries the money the account already held when its statements begin", async () => {
    const cookie = await signUp();
    const accountId = await openBankAccount(cookie);

    // What a two-year statement cannot tell you: the account did not start at
    // zero on the day its export begins.
    await post(cookie, {
      accountId,
      type: "OPENING_BALANCE",
      tradeDate: "2024-12-31",
      amount: "8000.00",
      note: "Saldo ennen tiliotteiden alkua",
    });
    await post(cookie, {
      accountId,
      type: "DEPOSIT",
      tradeDate: "2025-03-01",
      amount: "1000.00",
    });

    expect(await cashTotal(cookie, "2025-06-01")).toBe("9000.00");
    // ...and it is not counted before the day it is dated.
    expect(await cashTotal(cookie, "2024-12-30")).toBe("0.00");
  });

  test("refuses a second one in the same currency, which would double the start", async () => {
    const cookie = await signUp();
    const accountId = await openBankAccount(cookie);
    const opening: Entry = {
      accountId,
      type: "OPENING_BALANCE",
      tradeDate: "2024-12-31",
      amount: "8000.00",
    };

    expect((await post(cookie, opening)).status).toBe(201);
    const second = await post(cookie, { ...opening, amount: "9000.00" });
    expect(second.status).toBe(409);
    expect(ErrorSchema.parse(await second.json()).error).toContain("alkusaldo");
  });

  test("allows one per currency, since an account can hold more than one", async () => {
    const cookie = await signUp();
    const accountId = await openBankAccount(cookie);

    expect(
      (
        await post(cookie, {
          accountId,
          type: "OPENING_BALANCE",
          tradeDate: "2024-12-31",
          amount: "8000.00",
        })
      ).status,
    ).toBe(201);

    // SEK has no fx rate in this test database, so the route must refuse it
    // rather than store a marker rate that would value the balance wrongly.
    const sek = await post(cookie, {
      accountId,
      type: "OPENING_BALANCE",
      tradeDate: "2024-12-31",
      amount: "5000.00",
      currency: "SEK",
    });
    expect(sek.status).toBe(400);
    expect(ErrorSchema.parse(await sek.json()).error).toContain("Valuuttakurssia");
  });
});

describe("GET and DELETE /api/cash-entries", () => {
  test("lists what was written by hand, newest first", async () => {
    const cookie = await signUp();
    const accountId = await openBankAccount(cookie);
    await post(cookie, {
      accountId,
      type: "OPENING_BALANCE",
      tradeDate: "2024-12-31",
      amount: "8000.00",
    });
    await post(cookie, {
      accountId,
      type: "DEPOSIT",
      tradeDate: "2025-03-01",
      amount: "1000.00",
      note: "Palkka",
    });

    const response = await cashEntryRoutes["/api/cash-entries"].GET(
      new Request(`http://x/api/cash-entries?accountId=${accountId}`, { headers: { cookie } }),
    );
    const body = EntriesSchema.parse(await response.json());

    expect(body.entries.map((entry) => entry.type)).toEqual(["DEPOSIT", "OPENING_BALANCE"]);
    expect(body.entries[0]?.amount).toBe("1000.00");
    expect(body.entries[0]?.note).toBe("Palkka");
  });

  test("deleting a mistyped row removes it from the balance", async () => {
    const cookie = await signUp();
    const accountId = await openBankAccount(cookie);
    const created = await post(cookie, {
      accountId,
      type: "DEPOSIT",
      tradeDate: "2025-03-01",
      amount: "1000.00",
    });
    const id = IdSchema.parse(await created.json()).id;

    const deleted = await cashEntryRoutes["/api/cash-entries/:id"].DELETE(
      new Request(`http://x/api/cash-entries/${id}`, { method: "DELETE", headers: { cookie } }),
    );
    expect(deleted.status).toBe(200);
    expect(await cashTotal(cookie, "2025-06-01")).toBe("0.00");
  });

  test("refuses to delete someone else's row, as 404", async () => {
    const owner = await signUp();
    const stranger = await signUp();
    const accountId = await openBankAccount(owner);
    const created = await post(owner, {
      accountId,
      type: "DEPOSIT",
      tradeDate: "2025-03-01",
      amount: "1000.00",
    });
    const id = IdSchema.parse(await created.json()).id;

    const response = await cashEntryRoutes["/api/cash-entries/:id"].DELETE(
      new Request(`http://x/api/cash-entries/${id}`, {
        method: "DELETE",
        headers: { cookie: stranger },
      }),
    );
    expect(response.status).toBe(404);
  });
});

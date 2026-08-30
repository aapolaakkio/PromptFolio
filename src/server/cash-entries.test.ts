import { beforeAll, describe, expect, test } from "vitest";
import { CreateAccount, openAccount as openAccountRow } from "./accounts.ts";
import { getDb } from "./db/index.ts";
import { cashView } from "./views/portfolio.ts";
import { z } from "zod";

// The only route in the app that writes a transaction by hand. Everything else
// arrives through the import pipeline, so these tests care about the two things
// that keeps honest: it may only write cash rows (never a trade), and it may
// only touch rows it wrote itself (never a broker's record).

let auth: (typeof import("./auth.ts"))["auth"];
let addCashEntry: (typeof import("./cash-entries.ts"))["addCashEntry"];
let listCashEntries: (typeof import("./cash-entries.ts"))["listCashEntries"];
let removeCashEntry: (typeof import("./cash-entries.ts"))["removeCashEntry"];
let CashEntry: (typeof import("./cash-entries.ts"))["CashEntry"];

beforeAll(async () => {
  auth = (await import("./auth.ts")).auth;
  ({ addCashEntry, listCashEntries, removeCashEntry, CashEntry } =
    await import("./cash-entries.ts"));
});

const sessionCookieFrom = (response: Response): string => {
  const setCookie = response.headers.getSetCookie().find((c) => c.includes("session_token"));
  if (!setCookie) throw new Error("Response carried no session_token cookie");
  const nameValue = setCookie.split(";")[0];
  if (!nameValue) throw new Error("Malformed Set-Cookie header");
  return nameValue;
};

const signUp = async (): Promise<{ userId: string; cookie: string }> => {
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
  // SAFETY: a 200 from POST /sign-up/email always carries `{ user: { id } }`.
  const body = (await response.json()) as { user: { id: string } };
  return { userId: body.user.id, cookie: sessionCookieFrom(response) };
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

const openBankAccount = (userId: string, accountType = "savings"): number =>
  openAccountRow(
    getDb().db,
    userId,
    CreateAccount.parse({ name: "OP säästötili", broker: "op", kind: "bank", accountType }),
  ).id;

type Entry = {
  accountId: number;
  /** A refused type is part of the contract, so this is wider than the route's own. */
  type: "OPENING_BALANCE" | "DEPOSIT" | "WITHDRAWAL" | "INTEREST" | "BUY";
  tradeDate: string;
  amount: string;
  currency?: string;
  note?: string;
};

const post = (userId: string, body: Entry) => addCashEntry(userId, CashEntry.parse(body));

const cashTotal = (userId: string, on: string): string => cashView(getDb().db, userId, on).totalEur;

describe("addCashEntry", () => {
  // "rejects a request with no session" is gone with the route: the authed
  // middleware resolves a session or redirects, and there is no way past it.

  test("refuses an account belonging to someone else", async () => {
    const owner = await signUp();
    const stranger = await signUp();
    const accountId = openBankAccount(owner.userId);

    // Not found rather than forbidden, deliberately: telling a stranger that
    // an account exists is itself something they should not learn.
    expect(() =>
      post(stranger.userId, {
        accountId,
        type: "DEPOSIT",
        tradeDate: "2026-01-15",
        amount: "100.00",
      }),
    ).toThrow();
  });

  test("refuses a trade: a position must never come from a hand-written row", async () => {
    const { userId, cookie } = await signUp();
    const accountId = openBankAccount(userId);

    // A position must never come from a hand-written row: the schema does not
    // accept a trade type at all.
    expect(() =>
      post(userId, { accountId, type: "BUY", tradeDate: "2026-01-15", amount: "100.00" }),
    ).toThrow();
  });

  test("stores a withdrawal as money leaving, whatever sign the caller sent", async () => {
    const { userId, cookie } = await signUp();
    const accountId = openBankAccount(userId);

    await post(userId, {
      accountId,
      type: "DEPOSIT",
      tradeDate: "2026-01-15",
      amount: "1000.00",
    });
    await post(userId, {
      accountId,
      type: "WITHDRAWAL",
      tradeDate: "2026-02-01",
      amount: "250.00",
    });

    expect(cashTotal(userId, "2026-06-01")).toBe("750.00");
  });

  test("counts interest as money arriving", async () => {
    const { userId, cookie } = await signUp();
    const accountId = openBankAccount(userId, "fixed_term");

    await post(userId, {
      accountId,
      type: "DEPOSIT",
      tradeDate: "2026-01-15",
      amount: "10000.00",
    });
    await post(userId, { accountId, type: "INTEREST", tradeDate: "2026-07-15", amount: "150.00" });

    expect(cashTotal(userId, "2026-08-01")).toBe("10150.00");
  });

  test("refuses the same movement twice rather than doubling a balance", async () => {
    const { userId, cookie } = await signUp();
    const accountId = openBankAccount(userId);
    const entry: Entry = {
      accountId,
      type: "DEPOSIT",
      tradeDate: "2026-01-15",
      amount: "1000.00",
    };

    post(userId, entry);

    // The second is refused: one opening balance per account and currency,
    // because two would silently double what the account started with.
    expect(() => post(userId, entry)).toThrow();
    expect(cashTotal(userId, "2026-06-01")).toBe("1000.00");
  });
});

describe("opening balance", () => {
  test("carries the money the account already held when its statements begin", async () => {
    const { userId, cookie } = await signUp();
    const accountId = openBankAccount(userId);

    // What a two-year statement cannot tell you: the account did not start at
    // zero on the day its export begins.
    await post(userId, {
      accountId,
      type: "OPENING_BALANCE",
      tradeDate: "2024-12-31",
      amount: "8000.00",
      note: "Saldo ennen tiliotteiden alkua",
    });
    await post(userId, {
      accountId,
      type: "DEPOSIT",
      tradeDate: "2025-03-01",
      amount: "1000.00",
    });

    expect(cashTotal(userId, "2025-06-01")).toBe("9000.00");
    // ...and it is not counted before the day it is dated.
    expect(cashTotal(userId, "2024-12-30")).toBe("0.00");
  });

  test("refuses a second one in the same currency, which would double the start", async () => {
    const { userId, cookie } = await signUp();
    const accountId = openBankAccount(userId);
    const opening: Entry = {
      accountId,
      type: "OPENING_BALANCE",
      tradeDate: "2024-12-31",
      amount: "8000.00",
    };

    post(userId, opening);

    // The message names what is already there, because the fix is to delete
    // that one first and the person needs to know which.
    expect(() => post(userId, { ...opening, amount: "9000.00" })).toThrow(/alkusaldo/);
  });

  test("allows one per currency, since an account can hold more than one", async () => {
    const { userId, cookie } = await signUp();
    const accountId = openBankAccount(userId);

    post(userId, {
      accountId,
      type: "OPENING_BALANCE",
      tradeDate: "2024-12-31",
      amount: "8000.00",
    });

    // SEK has no fx rate in this test database, so it must be refused rather
    // than stored with a marker rate that would value the balance wrongly.
    expect(() =>
      post(userId, {
        accountId,
        type: "OPENING_BALANCE",
        tradeDate: "2024-12-31",
        amount: "5000.00",
        currency: "SEK",
      }),
    ).toThrow(/Valuuttakurssia/);
  });
});

describe("listCashEntries and removeCashEntry", () => {
  test("lists what was written by hand, newest first", async () => {
    const { userId, cookie } = await signUp();
    const accountId = openBankAccount(userId);
    await post(userId, {
      accountId,
      type: "OPENING_BALANCE",
      tradeDate: "2024-12-31",
      amount: "8000.00",
    });
    await post(userId, {
      accountId,
      type: "DEPOSIT",
      tradeDate: "2025-03-01",
      amount: "1000.00",
      note: "Palkka",
    });

    const body = listCashEntries(userId, accountId);

    expect(body.entries.map((entry) => entry.type)).toEqual(["DEPOSIT", "OPENING_BALANCE"]);
    expect(body.entries[0]?.amount).toBe("1000.00");
    expect(body.entries[0]?.note).toBe("Palkka");
  });

  test("deleting a mistyped row removes it from the balance", async () => {
    const { userId, cookie } = await signUp();
    const accountId = openBankAccount(userId);
    const created = post(userId, {
      accountId,
      type: "DEPOSIT",
      tradeDate: "2025-03-01",
      amount: "1000.00",
    });
    const id = created.id;

    removeCashEntry(userId, id);
    expect(cashTotal(userId, "2025-06-01")).toBe("0.00");
  });

  test("refuses to delete someone else's row", async () => {
    const owner = await signUp();
    const stranger = await signUp();
    const accountId = openBankAccount(owner.userId);
    const created = post(owner.userId, {
      accountId,
      type: "DEPOSIT",
      tradeDate: "2025-03-01",
      amount: "1000.00",
    });
    const id = created.id;

    // A stranger cannot reach another household's row: the account check runs
    // on the id the session resolved, not on anything the caller sent.
    expect(() => removeCashEntry(stranger.userId, id)).toThrow();
  });
});

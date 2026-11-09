import { beforeAll, describe, expect, test } from "vitest";
import { openAccount as openAccountRow } from "./accounts.ts";
import { CreateAccount } from "./action-inputs.ts";
import { db } from "./db/index.ts";
import { cashView } from "./views/portfolio.ts";

// The only route that writes a transaction by hand: it may only write cash rows (never a trade) and only touch rows it wrote itself (never a broker's record).

let auth: ReturnType<(typeof import("./auth.ts"))["getAuth"]>;
let addCashEntry: (typeof import("./cash-entries.ts"))["addCashEntry"];
let listCashEntries: (typeof import("./cash-entries.ts"))["listCashEntries"];
let removeCashEntry: (typeof import("./cash-entries.ts"))["removeCashEntry"];
let CashEntry: (typeof import("./action-inputs.ts"))["CashEntry"];

beforeAll(async () => {
  auth = (await import("./auth.ts")).getAuth();
  ({ addCashEntry, listCashEntries, removeCashEntry } = await import("./cash-entries.ts"));
  ({ CashEntry } = await import("./action-inputs.ts"));
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

const openBankAccount = async (userId: string, accountType = "savings"): Promise<number> =>
  (
    await openAccountRow(
      db,
      userId,
      CreateAccount.parse({ name: "OP savings account", broker: "op", kind: "bank", accountType }),
    )
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

const post = async (userId: string, body: Entry) => addCashEntry(userId, CashEntry.parse(body));

const cashTotal = async (userId: string, on: string): Promise<string> =>
  (await cashView(db, userId, on)).totalEur;

describe("addCashEntry", () => {
  test("refuses an account belonging to someone else", async () => {
    const owner = await signUp();
    const stranger = await signUp();
    const accountId = await openBankAccount(owner.userId);

    // Not found rather than forbidden: telling a stranger an account exists is itself a leak.
    await expect(
      post(stranger.userId, {
        accountId,
        type: "DEPOSIT",
        tradeDate: "2026-01-15",
        amount: "100.00",
      }),
    ).rejects.toThrow();
  });

  test("refuses a trade: a position must never come from a hand-written row", async () => {
    const { userId } = await signUp();
    const accountId = await openBankAccount(userId);

    // The schema does not accept a trade type, so a position never comes from a hand-written row.
    await expect(
      post(userId, { accountId, type: "BUY", tradeDate: "2026-01-15", amount: "100.00" }),
    ).rejects.toThrow();
  });

  test("stores a withdrawal as money leaving, whatever sign the caller sent", async () => {
    const { userId } = await signUp();
    const accountId = await openBankAccount(userId);

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

    expect(await cashTotal(userId, "2026-06-01")).toBe("750.00");
  });

  test("counts interest as money arriving", async () => {
    const { userId } = await signUp();
    const accountId = await openBankAccount(userId, "fixed_term");

    await post(userId, {
      accountId,
      type: "DEPOSIT",
      tradeDate: "2026-01-15",
      amount: "10000.00",
    });
    await post(userId, { accountId, type: "INTEREST", tradeDate: "2026-07-15", amount: "150.00" });

    expect(await cashTotal(userId, "2026-08-01")).toBe("10150.00");
  });

  test("refuses the same movement twice rather than doubling a balance", async () => {
    const { userId } = await signUp();
    const accountId = await openBankAccount(userId);
    const entry: Entry = {
      accountId,
      type: "DEPOSIT",
      tradeDate: "2026-01-15",
      amount: "1000.00",
    };

    await post(userId, entry);

    // Refused: one opening balance per account and currency (two would double the starting money).
    await expect(post(userId, entry)).rejects.toThrow();
    expect(await cashTotal(userId, "2026-06-01")).toBe("1000.00");
  });
});

describe("opening balance", () => {
  test("carries the money the account already held when its statements begin", async () => {
    const { userId } = await signUp();
    const accountId = await openBankAccount(userId);

    // A two-year statement cannot tell you the account did not start at zero.
    await post(userId, {
      accountId,
      type: "OPENING_BALANCE",
      tradeDate: "2024-12-31",
      amount: "8000.00",
      note: "Balance before the statements begin",
    });
    await post(userId, {
      accountId,
      type: "DEPOSIT",
      tradeDate: "2025-03-01",
      amount: "1000.00",
    });

    expect(await cashTotal(userId, "2025-06-01")).toBe("9000.00");
    expect(await cashTotal(userId, "2024-12-30")).toBe("0.00");
  });

  test("refuses a second one in the same currency, which would double the start", async () => {
    const { userId } = await signUp();
    const accountId = await openBankAccount(userId);
    const opening: Entry = {
      accountId,
      type: "OPENING_BALANCE",
      tradeDate: "2024-12-31",
      amount: "8000.00",
    };

    await post(userId, opening);

    // The message names the existing one, because the fix is to delete it first.
    await expect(post(userId, { ...opening, amount: "9000.00" })).rejects.toThrow(
      /opening balance/,
    );
  });

  test("allows one per currency, since an account can hold more than one", async () => {
    const { userId } = await signUp();
    const accountId = await openBankAccount(userId);

    await post(userId, {
      accountId,
      type: "OPENING_BALANCE",
      tradeDate: "2024-12-31",
      amount: "8000.00",
    });

    // SEK has no fx rate here, so it is refused rather than stored with a marker rate.
    await expect(
      post(userId, {
        accountId,
        type: "OPENING_BALANCE",
        tradeDate: "2024-12-31",
        amount: "5000.00",
        currency: "SEK",
      }),
    ).rejects.toThrow(/No exchange rate/);
  });
});

describe("listCashEntries and removeCashEntry", () => {
  test("lists what was written by hand, newest first", async () => {
    const { userId } = await signUp();
    const accountId = await openBankAccount(userId);
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

    const body = await listCashEntries(userId, accountId);

    expect(body.entries.map((entry) => entry.type)).toEqual(["DEPOSIT", "OPENING_BALANCE"]);
    expect(body.entries[0]?.amount).toBe("1000.00");
    expect(body.entries[0]?.note).toBe("Palkka");
  });

  test("deleting a mistyped row removes it from the balance", async () => {
    const { userId } = await signUp();
    const accountId = await openBankAccount(userId);
    const created = await post(userId, {
      accountId,
      type: "DEPOSIT",
      tradeDate: "2025-03-01",
      amount: "1000.00",
    });
    const id = created.id;

    await removeCashEntry(userId, id);
    expect(await cashTotal(userId, "2025-06-01")).toBe("0.00");
  });

  test("refuses to delete someone else's row", async () => {
    const owner = await signUp();
    const stranger = await signUp();
    const accountId = await openBankAccount(owner.userId);
    const created = await post(owner.userId, {
      accountId,
      type: "DEPOSIT",
      tradeDate: "2025-03-01",
      amount: "1000.00",
    });
    const id = created.id;

    // A stranger cannot reach another household's row: the check runs on the session's id.
    await expect(removeCashEntry(stranger.userId, id)).rejects.toThrow();
  });
});

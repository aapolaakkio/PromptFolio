import { beforeAll, describe, expect, test } from "vitest";
import { CreateAccount, openAccount as openAccountRow } from "./accounts.ts";
import { getDb } from "./db/index.ts";
import { addInstrument } from "./instruments/store.ts";
import { z } from "zod";

import { EUR } from "../core/money.ts";

// Exercises rebalanceRoutes against a real migrated database and a real Better
// Auth session, following portfolio.test.ts's setup: the shared getDb() handle
// is already pinned to a migrated in-memory database by ../test-setup.ts, so
// this file must not call resetDbHandleForTests() or migrate() itself. Every
// identity is derived from a fresh crypto.randomUUID(), because the database is
// shared with every other test file in the process.

let auth: (typeof import("./auth.ts"))["auth"];
let rebalance: typeof import("./rebalance.ts");
let toBasisPoints: (percent: string) => number;

beforeAll(async () => {
  auth = (await import("./auth.ts")).auth;
  rebalance = await import("./rebalance.ts");
  const { BASIS_POINTS } = await import("../core/rebalance/targets.ts");
  toBasisPoints = (percent) => Math.round(Number(percent.replace(",", ".")) * (BASIS_POINTS / 100));
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
        email: `rebalance-${crypto.randomUUID()}@example.com`,
        password: "correct horse battery staple",
      }),
    }),
  );
  if (response.status !== 200) throw new Error(`sign-up failed with status ${response.status}`);
  // SAFETY: a 200 from POST /sign-up/email always carries `{ user: { id } }`.
  const body = (await response.json()) as { user: { id: string } };
  return { userId: body.user.id, cookie: sessionCookieFrom(response) };
};

/** What the screen sends, so the helper does not take an unparsed `unknown`. */
type TargetsBody = {
  readonly dimension: "kind" | "currency" | "account" | "instrument";
  readonly targets: readonly { readonly key: string; readonly weightPercent: string }[];
};

/** Saves a set the way the server function does: percentages to basis points. */
const putTargets = (userId: string, body: TargetsBody) =>
  rebalance.saveTargets(
    getDb().db,
    userId,
    body.dimension,
    body.targets.map((target) => ({
      key: target.key,
      weightBp: toBasisPoints(target.weightPercent),
    })),
  );

const TargetsSchema = z.array(z.object({ key: z.string(), weightPercent: z.string() }));

describe("PUT /api/targets", () => {
  test("refuses a set that does not sum to 100 %, naming the total", async () => {
    const { userId } = await signUp();
    const result = putTargets(userId, {
      dimension: "kind",
      targets: [
        { key: "stock", weightPercent: "60" },
        { key: "fund", weightPercent: "30" },
      ],
    });

    expect(result.ok).toBe(false);
    // The owner sees what it sums to, not merely that it is wrong.
    expect(result.ok ? "" : result.message).toContain("90");
  });

  test("replaces a previous set wholesale rather than adding to it", async () => {
    const { userId } = await signUp();
    await putTargets(userId, {
      dimension: "kind",
      targets: [
        { key: "stock", weightPercent: "60" },
        { key: "fund", weightPercent: "40" },
      ],
    });
    await putTargets(userId, {
      dimension: "kind",
      targets: [
        { key: "stock", weightPercent: "50" },
        { key: "etf", weightPercent: "50" },
      ],
    });

    const targets = rebalance.targetsFor(getDb().db, userId, "kind");

    // Accumulating would leave a set summing to 200 %, refused on the next read
    // after the write had already happened.
    expect(targets.map((t) => t.key).sort()).toEqual(["etf", "stock"]);
    expect(targets.every((t) => t.weightPercent === "50.00")).toBe(true);
  });

  // The test that lived here checked the saved response against the screen's
  // own schema, because parsing it with the wrong one was indistinguishable
  // from the save having failed -- a successful write showed "tallennus
  // epäonnistui" until it existed. The screen no longer parses anything: it
  // calls the function and gets its return type, so the two shapes cannot
  // drift apart for a schema to catch.

  test("keeps one user's targets away from another's", async () => {
    const owner = await signUp();
    const stranger = await signUp();
    await putTargets(owner.userId, {
      dimension: "kind",
      targets: [{ key: "stock", weightPercent: "100" }],
    });

    expect(rebalance.targetsFor(getDb().db, stranger.userId, "kind")).toEqual([]);
  });

  // "refuses an anonymous caller" is gone with the route: every server function
  // on this screen declares the authed middleware, which resolves the session
  // or redirects, and there is no way to call one without going through it.
});

describe("the read routes", () => {
  /** A portfolio holding one instrument, so drift has something to be about. */
  const seed = async (): Promise<{ userId: string; cookie: string }> => {
    const { userId, cookie } = await signUp();
    const { prices, transactions } = await import("./db/schema.ts");

    const { id: accountId } = openAccountRow(
      getDb().db,
      userId,
      CreateAccount.parse({ name: "Nordnet", broker: "nordnet" }),
    );

    const isin = `XX${crypto.randomUUID().replace(/-/g, "").toUpperCase().slice(0, 9)}0`;
    const { id: instrumentId } = addInstrument(getDb().db, {
      isin,
      ticker: "TST",
      name: "Test Co",
      kind: "stock",
      currency: EUR,
      priceSource: "manual",
      sourceKey: isin,
    });

    getDb()
      .db.insert(transactions)
      .values({
        accountId,
        instrumentId,
        type: "BUY",
        tradeDate: "2025-01-10",
        quantity: 10_000_000,
        unitPrice: 10_00,
        amount: -100_00,
        fee: 5_00,
        tax: 0,
        currency: EUR,
        fxRateEur: 100_000_000,
        contentHash: crypto.randomUUID(),
        externalId: null,
        importId: null,
      })
      .run();
    getDb()
      .db.insert(prices)
      .values({
        instrumentId,
        date: "2025-06-02",
        close: 20_00,
        currency: EUR,
        source: "manual",
        fetchedAt: new Date("2025-06-02T00:00:00Z"),
      })
      .run();
    return { userId, cookie };
  };

  test("drift reports decimal strings and names each slice", async () => {
    const { userId } = await seed();
    await putTargets(userId, {
      dimension: "kind",
      targets: [{ key: "stock", weightPercent: "100" }],
    });

    const body = rebalance.driftReportFor(getDb().db, userId, "kind", "2025-06-02");

    // 10 shares at 20,00 -- the whole portfolio, and exactly on a 100 % target.
    expect(body.totalEur).toBe("200.00");
    expect(body.rows.find((row) => row.key === "stock")?.driftEur).toBe("0.00");
  });

  test("a fee report counts the commission paid on a purchase", async () => {
    const { userId } = await seed();

    const years = rebalance.feeReportFor(getDb().db, userId);

    expect(years[0]!.year).toBe(2025);
    expect(years[0]!.tradeFeesEur).toBe("5.00");
    expect(years[0]!.withheldTaxEur).toBe("0.00");
  });

  // Two tests that described the URL rather than the behaviour are gone: an
  // amount that is not an amount, and a grouping that is not one, are refused
  // by the server functions' validators before a handler runs -- and a caller
  // cannot express either, since the arguments are a union and a decimal string.
});

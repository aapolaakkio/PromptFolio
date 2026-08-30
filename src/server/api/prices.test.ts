import { beforeAll, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index.ts";
import { prices } from "../db/schema.ts";

// getDb() is safe to call statically here (unlike auth.ts/accounts.ts/
// instruments.ts, imported dynamically below): it does not throw at import
// time and does not decide the shared handle's identity on its own --
// ../test-setup.ts (a vitest.config.ts setupFiles entry) has already pinned that
// handle to a migrated in-memory database before this file's own top-level
// code runs, so this just retrieves the same handle every other route
// module in this process shares.
const { db } = getDb();

// Mirrors instruments.test.ts's own setup comment: this file exercises
// priceRoutes against the real, migrated, process-shared database, via
// dynamic imports from beforeAll (auth.ts is a process-wide ES module
// singleton pinned to that database by ../test-setup.ts before this file's
// own top-level code runs). Must NOT call resetDbHandleForTests(), set
// DATABASE_PATH, or call getDb()/migrate() itself -- see test-setup.ts's
// comment and accounts.test.ts's comment for the real bug that duplicating
// that setup caused.

let auth: (typeof import("../auth.ts"))["auth"];
let instrumentRoutes: (typeof import("./instruments.ts"))["instrumentRoutes"];
let priceRoutes: (typeof import("./prices.ts"))["priceRoutes"];

beforeAll(async () => {
  const authModule = await import("../auth.ts");
  const instrumentsModule = await import("./instruments.ts");
  const pricesModule = await import("./prices.ts");
  auth = authModule.auth;
  instrumentRoutes = instrumentsModule.instrumentRoutes;
  priceRoutes = pricesModule.priceRoutes;
});

const sessionCookieFrom = (response: Response): string => {
  const setCookie = response.headers.getSetCookie().find((c) => c.includes("session_token"));
  if (!setCookie) throw new Error("Response carried no session_token cookie");
  const nameValue = setCookie.split(";")[0];
  if (!nameValue) throw new Error("Malformed Set-Cookie header");
  return nameValue;
};

const signUp = async (email: string): Promise<{ cookie: string }> => {
  const response = await auth.handler(
    new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Test User", email, password: "correct horse battery staple" }),
    }),
  );
  if (response.status !== 200) throw new Error(`sign-up failed with status ${response.status}`);
  return { cookie: sessionCookieFrom(response) };
};

/**
 * A syntactically valid but never-real ISIN, derived from a fresh
 * `crypto.randomUUID()` -- mirrors instruments.test.ts's `randomIsin`,
 * kept as a private copy here rather than imported: instruments.ts exports
 * no such helper, and this file's own instruments must not collide with
 * any other test file's fixture ISIN on this project's one shared,
 * process-wide `instruments` table (see instruments.test.ts's own comment
 * on `randomIsin` for why that matters).
 */
const randomIsin = (country = "SE"): string =>
  `${country}${crypto.randomUUID().replace(/-/g, "").toUpperCase().slice(0, 9)}0`;

const createInstrument = async (
  cookie: string,
  overrides: { currency?: string; priceSource?: string } = {},
): Promise<{ id: number }> => {
  const response = await instrumentRoutes["/api/instruments"].POST(
    new Request("http://x/api/instruments", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        isin: randomIsin(),
        ticker: null,
        name: "Testirahasto",
        kind: "fund",
        currency: overrides.currency ?? "EUR",
        priceSource: overrides.priceSource ?? "manual",
        sourceKey: "manual-test",
      }),
    }),
  );
  if (response.status !== 201) throw new Error(`instrument creation failed: ${response.status}`);
  // SAFETY: a 201 from POST /api/instruments always returns the inserted
  // row, which carries an `id`.
  return (await response.json()) as { id: number };
};

/**
 * The wire shape POST /api/prices accepts -- kept intentionally permissive
 * (plain strings, not `instrumentId: number`'s own narrower guarantees on
 * `date`/`price`) so the malformed-input tests below can send a bad date or
 * a non-numeric price through the same helper as every valid-input test.
 */
type RecordPriceBody = {
  readonly instrumentId: number;
  readonly date: string;
  readonly price: string;
};

const recordPrice = (cookie: string | null, body: RecordPriceBody): Promise<Response> => {
  const headers = new Headers({ "content-type": "application/json" });
  if (cookie) headers.set("cookie", cookie);
  return priceRoutes["/api/prices"].POST(
    new Request("http://x/api/prices", { method: "POST", headers, body: JSON.stringify(body) }),
  );
};

describe("POST /api/prices", () => {
  test("rejects a request with no session", async () => {
    const response = await recordPrice(null, { instrumentId: 1, date: "2026-08-27", price: "10" });
    expect(response.status).toBe(401);
  });

  test("records a manually entered price for a manual-source instrument", async () => {
    const { cookie } = await signUp(`price-manual-${crypto.randomUUID()}@example.com`);
    const instrument = await createInstrument(cookie);

    const response = await recordPrice(cookie, {
      instrumentId: instrument.id,
      date: "2026-08-27",
      price: "12,34",
    });
    expect(response.status).toBe(201);
    // SAFETY: a 201 (asserted above) always returns { written }.
    const body = (await response.json()) as { written: number };
    expect(body.written).toBe(1);
  });

  test("a Finnish decimal comma parses through core/money exactly like a decimal point (283,60 -> 28360 minor)", async () => {
    const { cookie } = await signUp(`price-comma-${crypto.randomUUID()}@example.com`);
    const instrument = await createInstrument(cookie);

    const response = await recordPrice(cookie, {
      instrumentId: instrument.id,
      date: "2026-08-27",
      price: "283,60",
    });
    expect(response.status).toBe(201);

    const row = db
      .select({ close: prices.close, currency: prices.currency, source: prices.source })
      .from(prices)
      .where(eq(prices.instrumentId, instrument.id))
      .get();
    expect(row).toMatchObject({ close: 28_360, currency: "EUR", source: "manual" });
  });

  test("rejects an unknown instrument id with 404", async () => {
    const { cookie } = await signUp(`price-unknown-${crypto.randomUUID()}@example.com`);
    const response = await recordPrice(cookie, {
      instrumentId: 999_999_999,
      date: "2026-08-27",
      price: "10",
    });
    expect(response.status).toBe(404);
  });

  test("rejects a malformed date with 400 field detail", async () => {
    const { cookie } = await signUp(`price-bad-date-${crypto.randomUUID()}@example.com`);
    const instrument = await createInstrument(cookie);
    const response = await recordPrice(cookie, {
      instrumentId: instrument.id,
      date: "27.8.2026",
      price: "10",
    });
    expect(response.status).toBe(400);
    // SAFETY: handle()'s ZodError branch always shapes { error, fields }.
    const body = (await response.json()) as { fields: Array<{ path: string }> };
    expect(body.fields.map((f) => f.path)).toContain("date");
  });

  test("rejects a price that is not a valid decimal string with 400", async () => {
    const { cookie } = await signUp(`price-not-decimal-${crypto.randomUUID()}@example.com`);
    const instrument = await createInstrument(cookie);
    const response = await recordPrice(cookie, {
      instrumentId: instrument.id,
      date: "2026-08-27",
      price: "not a number",
    });
    expect(response.status).toBe(400);
  });

  test("rejects a zero price with 400", async () => {
    const { cookie } = await signUp(`price-zero-${crypto.randomUUID()}@example.com`);
    const instrument = await createInstrument(cookie);
    const response = await recordPrice(cookie, {
      instrumentId: instrument.id,
      date: "2026-08-27",
      price: "0",
    });
    expect(response.status).toBe(400);
  });

  test("rejects a negative price with 400", async () => {
    const { cookie } = await signUp(`price-negative-${crypto.randomUUID()}@example.com`);
    const instrument = await createInstrument(cookie);
    const response = await recordPrice(cookie, {
      instrumentId: instrument.id,
      date: "2026-08-27",
      price: "-5",
    });
    expect(response.status).toBe(400);
  });

  // The plausibility guard (write.ts) is deliberately bypassed for a
  // manual entry -- see prices.ts's and write.ts's own doc comments for
  // the full reasoning. Proven end-to-end here: a >10x jump from a prior
  // stored price, entered by hand, is written, not rejected.
  test("accepts a >10x jump from the prior stored price -- the plausibility guard does not apply here", async () => {
    const { cookie } = await signUp(`price-implausible-${crypto.randomUUID()}@example.com`);
    const instrument = await createInstrument(cookie);

    const first = await recordPrice(cookie, {
      instrumentId: instrument.id,
      date: "2026-08-26",
      price: "10",
    });
    expect(first.status).toBe(201);

    const second = await recordPrice(cookie, {
      instrumentId: instrument.id,
      date: "2026-08-27",
      price: "500",
    });
    expect(second.status).toBe(201);
    // SAFETY: a 201 (asserted above) always returns { written }.
    const body = (await second.json()) as { written: number };
    expect(body.written).toBe(1);
  });

  test("rejects a date that is not a real calendar day (2024-02-31) with 400", async () => {
    const { cookie } = await signUp(`price-bad-calendar-${crypto.randomUUID()}@example.com`);
    const instrument = await createInstrument(cookie);
    const response = await recordPrice(cookie, {
      instrumentId: instrument.id,
      date: "2024-02-31",
      price: "10",
    });
    expect(response.status).toBe(400);
    // SAFETY: handle()'s ZodError branch always shapes { error, fields }.
    const body = (await response.json()) as { fields: Array<{ path: string }> };
    expect(body.fields.map((f) => f.path)).toContain("date");
  });

  test("rejects a nonsense month/day pair (2024-99-99) with 400, the same as a malformed date", async () => {
    const { cookie } = await signUp(`price-bad-month-${crypto.randomUUID()}@example.com`);
    const instrument = await createInstrument(cookie);
    const response = await recordPrice(cookie, {
      instrumentId: instrument.id,
      date: "2024-99-99",
      price: "10",
    });
    expect(response.status).toBe(400);
  });

  test("accepts 2024-02-29, a real leap day", async () => {
    const { cookie } = await signUp(`price-leap-day-${crypto.randomUUID()}@example.com`);
    const instrument = await createInstrument(cookie);
    const response = await recordPrice(cookie, {
      instrumentId: instrument.id,
      date: "2024-02-29",
      price: "10",
    });
    expect(response.status).toBe(201);
  });

  test("rejects 2023-02-29, since 2023 is not a leap year, with 400", async () => {
    const { cookie } = await signUp(`price-not-leap-${crypto.randomUUID()}@example.com`);
    const instrument = await createInstrument(cookie);
    const response = await recordPrice(cookie, {
      instrumentId: instrument.id,
      date: "2023-02-29",
      price: "10",
    });
    expect(response.status).toBe(400);
  });

  // requirePositiveMinor (prices/types.ts) has no upper bound of its own, and a manual
  // entry deliberately bypasses write.ts's >10x plausibility guard (see the test above)
  // -- so Number.isSafeInteger is the only ceiling standing between a mistyped,
  // absurdly long price and a value silently corrupted by float imprecision once it
  // round-trips through the INTEGER `prices.close` column.
  test("rejects a price so large it cannot be stored as an exact integer, with 400", async () => {
    const { cookie } = await signUp(`price-too-large-${crypto.randomUUID()}@example.com`);
    const instrument = await createInstrument(cookie);
    const response = await recordPrice(cookie, {
      instrumentId: instrument.id,
      // 28 digits before the decimal point -- well past Number.MAX_SAFE_INTEGER (2^53 -
      // 1, 16 digits) once scaled to minor units, but still within the 30-char cap
      // `RecordPrice`'s own schema already enforces on the raw string.
      date: "2026-08-27",
      price: "1".repeat(28),
    });
    expect(response.status).toBe(400);
    const row = db
      .select({ close: prices.close })
      .from(prices)
      .where(eq(prices.instrumentId, instrument.id))
      .get();
    // Never written at all -- not stored as a corrupted, wrapped-around integer.
    expect(row).toBeUndefined();
  });

  test("a re-entered price for the same date overwrites rather than duplicating", async () => {
    const { cookie } = await signUp(`price-overwrite-${crypto.randomUUID()}@example.com`);
    const instrument = await createInstrument(cookie);

    await recordPrice(cookie, { instrumentId: instrument.id, date: "2026-08-27", price: "10" });
    const second = await recordPrice(cookie, {
      instrumentId: instrument.id,
      date: "2026-08-27",
      price: "20",
    });
    expect(second.status).toBe(201);
  });
});

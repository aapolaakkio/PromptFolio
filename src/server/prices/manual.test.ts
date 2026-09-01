import { beforeAll, describe, expect, test } from "vitest";
import { recordManualPrice } from "./manual.ts";
import { PriceInput } from "../../web/server/prices.ts";
import { EUR, type Currency } from "../../core/money.ts";

/** The four sources a price can come from, as the instrument store defines them. */
type PriceSource = "yahoo" | "nordnet_fund" | "op_fund" | "manual";
import { addInstrument } from "../instruments/store.ts";
import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { prices } from "../db/schema.ts";

// the shared database is safe to use statically here (unlike auth.ts/accounts.ts/
// instruments.ts, imported dynamically below): it does not throw at import
// time and does not decide the shared handle's identity on its own --
// ../test-setup.ts (a vitest.config.ts setupFiles entry) has already pinned that
// handle to a migrated in-memory database before this file's own top-level
// code runs, so this just retrieves the same handle every other route
// module in this process shares.

// Mirrors instruments.test.ts's own setup comment: this file exercises
// priceRoutes against the real, migrated, process-shared database, via
// dynamic imports from beforeAll (auth.ts is a process-wide ES module
// singleton pinned to that database by ../test-setup.ts before this file's
// own top-level code runs). Must NOT call resetDbHandleForTests(), set
// DATABASE_PATH, or call the shared database itself -- see test-setup.ts's
// comment and accounts.test.ts's comment for the real bug that duplicating
// that setup caused.

let auth: ReturnType<(typeof import("../auth.ts"))["getAuth"]>;

beforeAll(async () => {
  const authModule = await import("../auth.ts");
  auth = authModule.getAuth();
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
  overrides: { currency?: Currency; priceSource?: PriceSource } = {},
): Promise<{ id: number }> => {
  const created = await addInstrument(db, {
    isin: randomIsin(),
    ticker: null,
    name: "Testirahasto",
    kind: "fund",
    currency: overrides.currency ?? EUR,
    priceSource: overrides.priceSource ?? "manual",
    sourceKey: "manual-test",
  });
  return { id: created.id };
};

const recordPrice = async (body: { instrumentId: number; date: string; price: string }) =>
  recordManualPrice(db, PriceInput.parse(body));

describe("recordManualPrice", () => {
  // "rejects a request with no session" is the authed middleware's job now,
  // and it is not reachable from a direct call to the service.

  test("records a manually entered price for a manual-source instrument", async () => {
    const { cookie } = await signUp(`price-manual-${crypto.randomUUID()}@example.com`);
    const instrument = await createInstrument(cookie);

    const body = await recordPrice({
      instrumentId: instrument.id,
      date: "2026-08-27",
      price: "12,34",
    });
    expect(body.written).toBe(1);
  });

  test("a Finnish decimal comma parses through core/money exactly like a decimal point (283,60 -> 28360 minor)", async () => {
    const { cookie } = await signUp(`price-comma-${crypto.randomUUID()}@example.com`);
    const instrument = await createInstrument(cookie);

    await recordPrice({
      instrumentId: instrument.id,
      date: "2026-08-27",
      price: "283,60",
    });

    const row = await db
      .select({ close: prices.close, currency: prices.currency, source: prices.source })
      .from(prices)
      .where(eq(prices.instrumentId, instrument.id))
      .get();
    expect(row).toMatchObject({ close: 28_360, currency: EUR, source: "manual" });
  });

  test("rejects an unknown instrument id with 404", async () => {
    await signUp(`price-unknown-${crypto.randomUUID()}@example.com`);
    await expect(
      recordPrice({
        instrumentId: 999_999_999,
        date: "2026-08-27",
        price: "10",
      }),
    ).rejects.toThrow(/löydy/);
  });

  test("rejects a malformed date with 400 field detail", async () => {
    const { cookie } = await signUp(`price-bad-date-${crypto.randomUUID()}@example.com`);
    const instrument = await createInstrument(cookie);
    await expect(
      recordPrice({
        instrumentId: instrument.id,
        date: "27.8.2026",
        price: "10",
      }),
    ).rejects.toThrow();
    // The field is named by the schema now, not by an error envelope: parsing
    // it directly is what the server function's validator does.
    expect(PriceInput.safeParse({ instrumentId: 1, date: "2024-02-31", price: "10" }).success).toBe(
      false,
    );
  });

  test("rejects a price that is not a valid decimal string with 400", async () => {
    const { cookie } = await signUp(`price-not-decimal-${crypto.randomUUID()}@example.com`);
    const instrument = await createInstrument(cookie);
    await expect(
      recordPrice({
        instrumentId: instrument.id,
        date: "2026-08-27",
        price: "not a number",
      }),
    ).rejects.toThrow();
  });

  test("rejects a zero price with 400", async () => {
    const { cookie } = await signUp(`price-zero-${crypto.randomUUID()}@example.com`);
    const instrument = await createInstrument(cookie);
    await expect(
      recordPrice({
        instrumentId: instrument.id,
        date: "2026-08-27",
        price: "0",
      }),
    ).rejects.toThrow();
  });

  test("rejects a negative price with 400", async () => {
    const { cookie } = await signUp(`price-negative-${crypto.randomUUID()}@example.com`);
    const instrument = await createInstrument(cookie);
    await expect(
      recordPrice({
        instrumentId: instrument.id,
        date: "2026-08-27",
        price: "-5",
      }),
    ).rejects.toThrow();
  });

  // The plausibility guard (write.ts) is deliberately bypassed for a
  // manual entry -- see manual.ts's and write.ts's own doc comments for
  // the full reasoning. Proven end-to-end here: a >10x jump from a prior
  // stored price, entered by hand, is written, not rejected.
  test("accepts a >10x jump from the prior stored price -- the plausibility guard does not apply here", async () => {
    const { cookie } = await signUp(`price-implausible-${crypto.randomUUID()}@example.com`);
    const instrument = await createInstrument(cookie);

    await recordPrice({
      instrumentId: instrument.id,
      date: "2026-08-26",
      price: "10",
    });

    const second = recordPrice({
      instrumentId: instrument.id,
      date: "2026-08-27",
      price: "500",
    });
    const body = await second;
    expect(body.written).toBe(1);
  });

  test("rejects a date that is not a real calendar day (2024-02-31) with 400", async () => {
    const { cookie } = await signUp(`price-bad-calendar-${crypto.randomUUID()}@example.com`);
    const instrument = await createInstrument(cookie);
    await expect(
      recordPrice({
        instrumentId: instrument.id,
        date: "2024-02-31",
        price: "10",
      }),
    ).rejects.toThrow();
    // The field is named by the schema now, not by an error envelope: parsing
    // it directly is what the server function's validator does.
    expect(PriceInput.safeParse({ instrumentId: 1, date: "2024-02-31", price: "10" }).success).toBe(
      false,
    );
  });

  test("rejects a nonsense month/day pair (2024-99-99) with 400, the same as a malformed date", async () => {
    const { cookie } = await signUp(`price-bad-month-${crypto.randomUUID()}@example.com`);
    const instrument = await createInstrument(cookie);
    await expect(
      recordPrice({
        instrumentId: instrument.id,
        date: "2024-99-99",
        price: "10",
      }),
    ).rejects.toThrow();
  });

  test("accepts 2024-02-29, a real leap day", async () => {
    const { cookie } = await signUp(`price-leap-day-${crypto.randomUUID()}@example.com`);
    const instrument = await createInstrument(cookie);
    await recordPrice({
      instrumentId: instrument.id,
      date: "2024-02-29",
      price: "10",
    });
  });

  test("rejects 2023-02-29, since 2023 is not a leap year, with 400", async () => {
    const { cookie } = await signUp(`price-not-leap-${crypto.randomUUID()}@example.com`);
    const instrument = await createInstrument(cookie);
    await expect(
      recordPrice({
        instrumentId: instrument.id,
        date: "2023-02-29",
        price: "10",
      }),
    ).rejects.toThrow();
  });

  // requirePositiveMinor (prices/types.ts) has no upper bound of its own, and a manual
  // entry deliberately bypasses write.ts's >10x plausibility guard (see the test above)
  // -- so Number.isSafeInteger is the only ceiling standing between a mistyped,
  // absurdly long price and a value silently corrupted by float imprecision once it
  // round-trips through the INTEGER `prices.close` column.
  test("rejects a price so large it cannot be stored as an exact integer, with 400", async () => {
    const { cookie } = await signUp(`price-too-large-${crypto.randomUUID()}@example.com`);
    const instrument = await createInstrument(cookie);
    await expect(
      recordPrice({
        instrumentId: instrument.id,
        // 28 digits before the decimal point -- well past Number.MAX_SAFE_INTEGER (2^53 -
        // 1, 16 digits) once scaled to minor units, but still within the 30-char cap
        // `RecordPrice`'s own schema already enforces on the raw string.
        date: "2026-08-27",
        price: "1".repeat(28),
      }),
    ).rejects.toThrow();
    const row = await db
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

    await recordPrice({ instrumentId: instrument.id, date: "2026-08-27", price: "10" });
    await recordPrice({
      instrumentId: instrument.id,
      date: "2026-08-27",
      price: "20",
    });
  });
});

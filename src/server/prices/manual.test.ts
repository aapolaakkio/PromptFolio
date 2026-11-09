import { beforeAll, describe, expect, test } from "vitest";
import { recordManualPrice } from "./manual.ts";
import { PriceInput } from "../action-inputs.ts";
import { EUR, type Currency } from "../../core/money.ts";

type PriceSource = "yahoo" | "manual";
import { addInstrument } from "../instruments/store.ts";
import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { prices } from "../db/schema.ts";

// The shared database is safe to import statically: ../test-setup.ts has already pinned it to a migrated in-memory database.

// Exercises priceRoutes against the shared database via dynamic imports from beforeAll. Must NOT call resetDbHandleForTests() or set DATABASE_PATH (see test-setup.ts).

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

/** A valid but never-real ISIN from a fresh UUID, so fixtures never collide on the shared `instruments` table. */
const randomIsin = (country = "SE"): string =>
  `${country}${crypto.randomUUID().replace(/-/g, "").toUpperCase().slice(0, 9)}0`;

const createInstrument = async (
  cookie: string,
  overrides: { currency?: Currency; priceSource?: PriceSource } = {},
): Promise<{ id: number }> => {
  const created = await addInstrument(db, {
    isin: randomIsin(),
    ticker: null,
    name: "Test fund",
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
    ).rejects.toThrow(/not found/);
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

  // The plausibility guard is bypassed for manual entry: a >10x jump entered by hand is written.
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

  // Number.isSafeInteger is the only ceiling for an absurdly long manual price, which would otherwise corrupt in the INTEGER `prices.close` column.
  test("rejects a price so large it cannot be stored as an exact integer, with 400", async () => {
    const { cookie } = await signUp(`price-too-large-${crypto.randomUUID()}@example.com`);
    const instrument = await createInstrument(cookie);
    await expect(
      recordPrice({
        instrumentId: instrument.id,
        // 28 digits: past MAX_SAFE_INTEGER once scaled, within `RecordPrice`'s 30-char cap.
        date: "2026-08-27",
        price: "1".repeat(28),
      }),
    ).rejects.toThrow();
    const row = await db
      .select({ close: prices.close })
      .from(prices)
      .where(eq(prices.instrumentId, instrument.id))
      .get();
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

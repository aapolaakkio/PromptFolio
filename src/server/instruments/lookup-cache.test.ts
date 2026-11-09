import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { parseCurrency } from "../../core/money.ts";
import { db } from "../db/index.ts";
import { instrumentLookups, yahooGate } from "../db/schema.ts";
import { readText } from "../files.ts";
import type { FetchImpl } from "../prices/types.ts";
import { lookupKey, rememberedLookup } from "./lookup-cache.ts";

const EUR = parseCurrency("EUR");
const WEEK_MS = 7 * 24 * 60 * 60_000;
const NOW = 1_800_000_000_000;

const NAME_FOUND = "OP-MAAILMA INDEKSI A";
const NAME_NOTHING = `Nothing Cache Test ${crypto.randomUUID()}`;
const keys = [lookupKey(null, NAME_FOUND), lookupKey(null, NAME_NOTHING)];

const counted = (respond: () => Promise<Response>) => {
  let n = 0;
  return {
    fetch: (async () => {
      n += 1;
      return respond();
    }) satisfies FetchImpl,
    calls: () => n,
  };
};

const opFund = async (): Promise<Response> =>
  new Response(await readText(new URL("./fixtures/op-fund-maailma.html", import.meta.url)));
const empty = async (): Promise<Response> => new Response(JSON.stringify({ quotes: [] }));
const tooMany = async (): Promise<Response> => new Response("", { status: 429 });

const clean = async (): Promise<void> => {
  for (const key of keys) await db.delete(instrumentLookups).where(eq(instrumentLookups.key, key));
  await db.delete(yahooGate).run();
};

beforeEach(clean);
afterEach(clean);

describe("lookupKey", () => {
  test("is the ISIN, or the trimmed lowercased name", () => {
    expect(lookupKey("FI0009000681", "Nokia")).toBe("FI0009000681");
    expect(lookupKey(null, "  Nokia Oyj ")).toBe("name:nokia oyj");
  });
});

describe("rememberedLookup", () => {
  test("a found lookup is asked once", async () => {
    const stub = counted(opFund);
    const first = await rememberedLookup(db, null, NAME_FOUND, EUR, stub.fetch, () => NOW, 0);
    const callsAfterFirst = stub.calls();
    const second = await rememberedLookup(db, null, NAME_FOUND, EUR, stub.fetch, () => NOW, 0);
    expect(first.outcome).toBe("found");
    expect(callsAfterFirst).toBeGreaterThan(0);
    expect(stub.calls()).toBe(callsAfterFirst);
    expect(second).toEqual(first);
  });

  test("nothing-found is asked again after a week", async () => {
    const stub = counted(empty);
    const first = await rememberedLookup(db, null, NAME_NOTHING, EUR, stub.fetch, () => NOW, 0);
    expect(first.outcome).toBe("form");
    const callsAfterFirst = stub.calls();

    await rememberedLookup(db, null, NAME_NOTHING, EUR, stub.fetch, () => NOW + WEEK_MS, 0);
    expect(stub.calls()).toBe(callsAfterFirst);

    await rememberedLookup(db, null, NAME_NOTHING, EUR, stub.fetch, () => NOW + WEEK_MS + 1, 0);
    expect(stub.calls()).toBeGreaterThan(callsAfterFirst);
  });

  test("a pending answer is retried at once", async () => {
    const paused = counted(tooMany);
    const first = await rememberedLookup(db, null, NAME_NOTHING, EUR, paused.fetch, () => NOW, 0);
    expect(first.outcome).toBe("pending");

    await db.delete(yahooGate).run();
    const open = counted(empty);
    const second = await rememberedLookup(db, null, NAME_NOTHING, EUR, open.fetch, () => NOW, 0);
    expect(open.calls()).toBeGreaterThan(0);
    expect(second.outcome).toBe("form");
  });

  test("a malformed stored row counts as a miss", async () => {
    await db.insert(instrumentLookups).values({
      key: lookupKey(null, NAME_NOTHING),
      outcome: "found",
      result: '{"old":"shape"}',
      checkedAt: new Date(NOW),
    });
    const stub = counted(empty);
    const result = await rememberedLookup(db, null, NAME_NOTHING, EUR, stub.fetch, () => NOW, 0);
    expect(stub.calls()).toBeGreaterThan(0);
    expect(result.outcome).toBe("form");
  });

  test("a cached found in another currency than the holding's goes to the form", async () => {
    const isin = `XS${String(Math.floor(Math.random() * 1e10)).padStart(10, "0")}`;
    keys.push(isin);
    const usd = {
      kind: "stock",
      name: "Registry Name",
      priceSource: "yahoo",
      sourceKey: "ABC",
      isin,
      listingCurrency: "USD",
      outcome: "found",
      formReason: null,
    };
    await db.insert(instrumentLookups).values({
      key: isin,
      outcome: "found",
      result: JSON.stringify(usd),
      checkedAt: new Date(NOW),
    });
    const stub = counted(empty);

    const result = await rememberedLookup(db, isin, "ABC", EUR, stub.fetch, () => NOW, 0);

    expect(stub.calls()).toBe(0);
    // A row stored before page sources existed reads with no recipe.
    expect(result).toEqual({ ...usd, outcome: "form", formReason: "currency", pageRecipe: null });
    const row = await db
      .select()
      .from(instrumentLookups)
      .where(eq(instrumentLookups.key, isin))
      .get();
    expect(row?.outcome).toBe("found");
  });
});

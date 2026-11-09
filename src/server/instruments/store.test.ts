import { describe, expect, test } from "vitest";

import { parseCurrency } from "../../core/money.ts";
import { db } from "../db/index.ts";
import { eq } from "drizzle-orm";

import { prices } from "../db/schema.ts";
import {
  addInstrument,
  addPageInstrument,
  listInstruments,
  updateInstrument,
  updatePageInstrument,
} from "./store.ts";
import type { ChatClient } from "../chat/runner.ts";
import { testDb } from "../db/test-db.ts";
import { instruments, pageRecipes } from "../db/schema.ts";
import type { PageRecipe } from "../prices/page-recipe.ts";

// Replaces api/instruments.test.ts's HTTP checks; the session and 400-detail cases moved to middleware and zod.

const EUR = parseCurrency("EUR");
const SEK = parseCurrency("SEK");

const randomIsin = (): string =>
  `XX${crypto.randomUUID().replace(/-/g, "").toUpperCase().slice(0, 9)}0`;

describe("addInstrument", () => {
  test("registers one and hands back the stored row", async () => {
    const isin = randomIsin();

    const created = await addInstrument(db, {
      isin,
      ticker: "KNEBV.HE",
      name: "Kone",
      kind: "stock",
      currency: EUR,
      priceSource: "manual",
      sourceKey: "KNEBV.HE",
    });

    expect(created.isin).toBe(isin);
    expect(created.name).toBe("Kone");
  });

  test("refuses a duplicate ISIN, naming it", async () => {
    const isin = randomIsin();
    const row = {
      isin,
      ticker: null,
      name: `Kesko ${isin}`,
      kind: "stock" as const,
      currency: EUR,
      priceSource: "manual" as const,
      sourceKey: isin,
    };
    await addInstrument(db, row);

    // The ISIN is in the message because it is what the person is resolving.
    await expect(addInstrument(db, row)).rejects.toThrow(isin);
  });

  test("refuses a duplicate name when there is no ISIN to match on", async () => {
    // A manual holding has no ISIN any registry gives up, so the name is all there is to match.
    const name = `Manuaalinen ${crypto.randomUUID()}`;
    const row = {
      ticker: null,
      name,
      kind: "stock" as const,
      currency: EUR,
      priceSource: "manual" as const,
    };
    await addInstrument(db, row);

    await expect(addInstrument(db, row)).rejects.toThrow(name);
  });

  test("keeps a non-EUR currency as its own", async () => {
    const isin = randomIsin();

    const created = await addInstrument(db, {
      isin,
      ticker: null,
      name: `Ruotsalainen ${isin}`,
      kind: "stock",
      currency: SEK,
      priceSource: "manual",
      sourceKey: isin,
    });

    expect(created.currency).toBe(SEK);
  });

  test("falls back to the ISIN, then the name, for a missing source key", async () => {
    const isin = randomIsin();
    const byIsin = await addInstrument(db, {
      isin,
      ticker: null,
      name: `Without a key ${isin}`,
      kind: "fund",
      currency: EUR,
      priceSource: "manual",
    });
    const name = `Named ${crypto.randomUUID()}`;
    const byName = await addInstrument(db, {
      ticker: null,
      name,
      kind: "fund",
      currency: EUR,
      priceSource: "manual",
    });

    expect(byIsin.sourceKey).toBe(isin);
    expect(byName.sourceKey).toBe(name);
  });
});

describe("listInstruments", () => {
  test("returns what any signed-in member can see, which is all of them", async () => {
    // Shared reference data: nothing to scope per user.
    const isin = randomIsin();
    await addInstrument(db, {
      isin,
      ticker: null,
      name: `Jaettu ${isin}`,
      kind: "stock",
      currency: EUR,
      priceSource: "manual",
      sourceKey: isin,
    });

    expect((await listInstruments(db)).some((row) => row.isin === isin)).toBe(true);
  });
});

describe("updateInstrument", () => {
  const add = () =>
    addInstrument(db, {
      isin: randomIsin(),
      ticker: null,
      name: "Nordnet Norge Indeks",
      kind: "fund",
      currency: EUR,
      priceSource: "manual",
      sourceKey: "",
    });

  test("corrects the currency, and drops prices stored in the old one", async () => {
    const fund = await add();
    await db
      .insert(prices)
      .values({
        instrumentId: fund.id,
        date: "2026-11-05",
        close: 1000,
        currency: EUR,
        source: "manual",
        fetchedAt: new Date(),
      })
      .run();

    const updated = await updateInstrument(db, fund.id, {
      currency: parseCurrency("NOK"),
      priceSource: "page",
      sourceKey: "https://www.nordnet.fi/rahastot/lista/nordnet-norge-indeks-nok-52540035",
    });

    expect(updated.currency).toBe("NOK");
    expect(updated.priceSource).toBe("page");
    expect(updated.sourceKey).toBe(
      "https://www.nordnet.fi/rahastot/lista/nordnet-norge-indeks-nok-52540035",
    );
    expect(await db.select().from(prices).where(eq(prices.instrumentId, fund.id)).all()).toEqual(
      [],
    );
  });

  test("keeps stored prices when the currency stays the same", async () => {
    const fund = await add();
    await db
      .insert(prices)
      .values({
        instrumentId: fund.id,
        date: "2026-11-05",
        close: 1000,
        currency: EUR,
        source: "manual",
        fetchedAt: new Date(),
      })
      .run();

    await updateInstrument(db, fund.id, { currency: EUR, priceSource: "manual", sourceKey: "" });

    expect(
      await db.select().from(prices).where(eq(prices.instrumentId, fund.id)).all(),
    ).toHaveLength(1);
  });

  test("refuses an automatic source with no source code, and an unknown instrument", async () => {
    const fund = await add();
    await expect(
      updateInstrument(db, fund.id, { currency: EUR, priceSource: "page", sourceKey: " " }),
    ).rejects.toThrow("source code");
    await expect(
      updateInstrument(db, 999_999, { currency: EUR, priceSource: "manual", sourceKey: "" }),
    ).rejects.toThrow("not found");
  });
});

describe("page instruments", () => {
  const PAGE_ISIN = "FI0000000001";
  const URL_A = "https://example.test/fund";
  const RECIPE: PageRecipe = {
    kind: "page",
    pattern: String.raw`NAV (?<price>[\d,]+) (?<currency>[A-Z]{3}) (?<date>\d{2}\.\d{2}\.\d{4})`,
    dateFormat: "dd.mm.yyyy",
    money: { decimal: ",", thousands: "", negative: "leading", twoColumn: false },
    currency: null,
  };
  const html = (nav: string) => `<h1>Fund ${PAGE_ISIN}</h1><p>NAV ${nav} EUR 26.08.2026</p>`;
  const serve = (body: string) => async (): Promise<Response> => new Response(body);
  const model = (recipe: PageRecipe): ChatClient & { calls: number } => {
    const client = {
      calls: 0,
      run: async () => {
        client.calls += 1;
        return { text: JSON.stringify(recipe), toolCalls: [] };
      },
    };
    return client;
  };
  const deps = (body: string, client: ChatClient) => ({
    fetchImpl: serve(body),
    client,
    today: "2026-08-27",
  });
  const NEW = {
    isin: PAGE_ISIN,
    ticker: null,
    name: "Test fund",
    kind: "fund" as const,
    currency: EUR,
    priceSource: "page" as const,
    sourceKey: URL_A,
  };

  test("saving a page URL stores the verified recipe and its price", async () => {
    const { db: tdb } = await testDb();

    const saved = await addPageInstrument(tdb, NEW, deps(html("12,34"), model(RECIPE)));

    expect(saved.price).toEqual({ date: "2026-08-26", closeMinor: 1234, currency: EUR });
    const row = await tdb.select().from(pageRecipes).get();
    expect(row?.instrumentId).toBe(saved.instrument.id);
    expect(JSON.parse(row?.recipe ?? "null")).toEqual(RECIPE);
    const stored = await tdb.select().from(prices).all();
    expect(stored.map((p) => [p.date, p.close])).toEqual([["2026-08-26", 1234]]);
  });

  test("a page that cannot be read is refused and nothing changes", async () => {
    const { db: tdb } = await testDb();
    const useless = { ...RECIPE, pattern: String.raw`(?<date>nope)(?<price>nope)` };

    await expect(
      addPageInstrument(tdb, NEW, deps(html("12,34"), model(useless))),
    ).rejects.toMatchObject({ status: 400 });

    expect(await tdb.select().from(instruments).all()).toEqual([]);
    expect(await tdb.select().from(pageRecipes).all()).toEqual([]);
    expect(await tdb.select().from(prices).all()).toEqual([]);
  });

  test("a non-https URL is refused", async () => {
    const { db: tdb } = await testDb();
    const client = model(RECIPE);

    await expect(
      addPageInstrument(
        tdb,
        { ...NEW, sourceKey: "http://example.test/fund" },
        deps(html("12,34"), client),
      ),
    ).rejects.toMatchObject({ status: 400 });

    expect(client.calls).toBe(0);
    expect(await tdb.select().from(instruments).all()).toEqual([]);
  });

  test("Edit to a new URL replaces the recipe", async () => {
    const { db: tdb } = await testDb();
    const first = await addPageInstrument(tdb, NEW, deps(html("12,34"), model(RECIPE)));
    const next: PageRecipe = {
      ...RECIPE,
      pattern: String.raw`Arvo (?<price>[\d,]+) (?<currency>[A-Z]{3}) (?<date>\d{2}\.\d{2}\.\d{4})`,
    };
    const page2 = `<h1>${PAGE_ISIN}</h1><p>Arvo 12,50 EUR 26.08.2026</p>`;

    const updated = await updatePageInstrument(
      tdb,
      first.instrument.id,
      { currency: EUR, priceSource: "page", sourceKey: "https://example.test/uusi" },
      deps(page2, model(next)),
    );

    expect(updated.price.closeMinor).toBe(1250);
    expect(updated.instrument.sourceKey).toBe("https://example.test/uusi");
    const row = await tdb.select().from(pageRecipes).get();
    expect(JSON.parse(row?.recipe ?? "null")).toEqual(next);
  });

  test("a failed Edit check changes nothing", async () => {
    const { db: tdb } = await testDb();
    const first = await addPageInstrument(tdb, NEW, deps(html("12,34"), model(RECIPE)));
    const before = {
      instrument: await tdb.select().from(instruments).all(),
      prices: await tdb.select().from(prices).all(),
      recipes: await tdb.select().from(pageRecipes).all(),
    };
    const useless = { ...RECIPE, pattern: String.raw`(?<date>nope)(?<price>nope)` };

    await expect(
      updatePageInstrument(
        tdb,
        first.instrument.id,
        { currency: SEK, priceSource: "page", sourceKey: "https://example.test/uusi" },
        deps(html("12,34"), model(useless)),
      ),
    ).rejects.toMatchObject({ status: 400 });

    expect(await tdb.select().from(instruments).all()).toEqual(before.instrument);
    expect(await tdb.select().from(prices).all()).toEqual(before.prices);
    expect(await tdb.select().from(pageRecipes).all()).toEqual(before.recipes);
  });

  test("a duplicate is refused before the model is asked", async () => {
    const { db: tdb } = await testDb();
    await addPageInstrument(tdb, NEW, deps(html("12,34"), model(RECIPE)));
    const client = model(RECIPE);

    await expect(addPageInstrument(tdb, NEW, deps(html("12,34"), client))).rejects.toMatchObject({
      status: 409,
    });
    expect(client.calls).toBe(0);
  });
});

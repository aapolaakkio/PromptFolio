import { eq } from "drizzle-orm";
import { expect, test } from "vitest";

import { EUR } from "../../core/money.ts";
import type { ChatClient, ModelReply } from "../chat/runner.ts";
import { testDb } from "../db/test-db.ts";
import { instruments, pageRecipes, priceFetchLog, prices } from "../db/schema.ts";
import { refreshPage } from "./page.ts";
import type { PageRecipe } from "./page-recipe.ts";

type TestDb = Awaited<ReturnType<typeof testDb>>["db"];

const ISIN = "FI0000000001";
const DAY = 86_400_000;
const NOW = Date.parse("2026-08-27T18:00:00Z");

const RECIPE: PageRecipe = {
  kind: "page",
  pattern: String.raw`NAV (?<price>[\d,]+) (?<currency>[A-Z]{3}) (?<date>\d{2}\.\d{2}\.\d{4})`,
  dateFormat: "dd.mm.yyyy",
  money: { decimal: ",", thousands: "", negative: "leading", twoColumn: false },
  currency: null,
};
const page = (nav: string, date: string) => `<h1>Rahasto ${ISIN}</h1><p>NAV ${nav} EUR ${date}</p>`;
const respond = (html: string) => async (): Promise<Response> => new Response(html);

const noModel: ChatClient = {
  run: async () => {
    throw new Error("model must not be called");
  },
};
const scripted = (...texts: string[]): ChatClient & { calls: number } => {
  const client = {
    calls: 0,
    run: async (): Promise<ModelReply> => {
      const text = texts[Math.min(client.calls, texts.length - 1)] ?? "";
      client.calls += 1;
      return { text, toolCalls: [] };
    },
  };
  return client;
};

const seedPage = async (db: TestDb, recipe: PageRecipe | null, askedAt: number | null = null) => {
  const instrument = await db
    .insert(instruments)
    .values({
      isin: ISIN,
      ticker: null,
      name: "Testirahasto",
      kind: "fund",
      currency: EUR,
      priceSource: "page",
      sourceKey: "https://example.test/rahasto",
    })
    .returning()
    .get();
  if (recipe !== null || askedAt !== null) {
    await db
      .insert(pageRecipes)
      .values({
        instrumentId: instrument.id,
        recipe: recipe === null ? null : JSON.stringify(recipe),
        askedAt,
      })
      .run();
  }
  return instrument;
};

const statusOf = async (db: TestDb, id: number) =>
  (await db.select().from(instruments).where(eq(instruments.id, id)).get())?.lookupStatus;

const current = async (db: TestDb, id: number) => {
  const row = await db.select().from(instruments).where(eq(instruments.id, id)).get();
  if (row === undefined) throw new Error("instrument missing");
  return row;
};

const run = async (
  db: TestDb,
  instrument: typeof instruments.$inferSelect,
  html: string,
  client: ChatClient | null,
  over: { today?: string; now?: number } = {},
) =>
  refreshPage(db, await current(db, instrument.id), {
    fetchImpl: respond(html),
    client,
    today: over.today ?? "2026-08-27",
    now: over.now ?? NOW,
  });

test("a stored recipe prices the page with no model call", async () => {
  const { db } = await testDb();
  const instrument = await seedPage(db, RECIPE);

  const result = await run(db, instrument, page("12,34", "26.08.2026"), noModel);

  expect(result).toBe("ok");
  const rows = await db.select().from(prices).where(eq(prices.instrumentId, instrument.id)).all();
  expect(rows.map((r) => [r.date, r.close, r.source])).toEqual([["2026-08-26", 1234, "page"]]);
  const log = await db.select().from(priceFetchLog).all();
  expect(log.map((l) => [l.source, l.ok])).toEqual([["page", true]]);
});

test("a recipe that reads nothing asks once, stores the new recipe and the price", async () => {
  const { db } = await testDb();
  const stale = { ...RECIPE, pattern: String.raw`(?<date>nope)(?<price>nope)` };
  const instrument = await seedPage(db, stale);
  const client = scripted(JSON.stringify(RECIPE));

  const result = await run(db, instrument, page("12,34", "26.08.2026"), client);

  expect(result).toBe("ok");
  expect(client.calls).toBe(1);
  const stored = await db.select().from(pageRecipes).get();
  expect(JSON.parse(stored?.recipe ?? "null")).toEqual(RECIPE);
  expect(stored?.askedAt).toBe(NOW);
  expect(await db.select().from(prices).all()).toHaveLength(1);
});

test("no stored recipe asks the model", async () => {
  const { db } = await testDb();
  const instrument = await seedPage(db, null);
  const client = scripted(JSON.stringify(RECIPE));
  expect(await run(db, instrument, page("12,34", "26.08.2026"), client)).toBe("ok");
  expect(client.calls).toBe(1);
});

test("a stale read counts as reading nothing", async () => {
  const { db } = await testDb();
  const instrument = await seedPage(db, RECIPE);
  const client = scripted("ei kelpaa");
  const result = await run(db, instrument, page("12,34", "01.01.2026"), client);
  expect(result).toBe("attention");
  expect(client.calls).toBeGreaterThan(0);
  expect(await db.select().from(prices).all()).toEqual([]);
});

test("a failed ask marks attention and writes nothing", async () => {
  const { db } = await testDb();
  const instrument = await seedPage(db, null);
  const client = scripted("ei kelpaa");

  const result = await run(db, instrument, page("12,34", "26.08.2026"), client);

  expect(result).toBe("attention");
  expect(await statusOf(db, instrument.id)).toBe("attention");
  expect(await db.select().from(prices).all()).toEqual([]);
  expect((await db.select().from(pageRecipes).get())?.askedAt).toBe(NOW);
  expect((await db.select().from(priceFetchLog).all()).some((l) => !l.ok)).toBe(true);
});

test("the next night within 7 days makes no model call", async () => {
  const { db } = await testDb();
  const instrument = await seedPage(db, null, NOW - DAY);

  const result = await run(db, instrument, "<p>sivu muuttui</p>", noModel);

  expect(result).toBe("failed");
});

test("after 7 days the model is asked again", async () => {
  const { db } = await testDb();
  const instrument = await seedPage(db, null, NOW - 7 * DAY);
  const client = scripted(JSON.stringify(RECIPE));
  expect(await run(db, instrument, page("12,34", "26.08.2026"), client)).toBe("ok");
  expect(client.calls).toBe(1);
});

test("with no client nothing is asked and the result is failed", async () => {
  const { db } = await testDb();
  const instrument = await seedPage(db, null);
  expect(await run(db, instrument, "<p>x</p>", null)).toBe("failed");
  expect((await db.select().from(pageRecipes).get())?.askedAt ?? null).toBeNull();
});

test("an unreadable stored recipe counts as no recipe", async () => {
  const { db } = await testDb();
  const instrument = await seedPage(db, null);
  await db.insert(pageRecipes).values({ instrumentId: instrument.id, recipe: "{oops" }).run();
  const client = scripted(JSON.stringify(RECIPE));
  expect(await run(db, instrument, page("12,34", "26.08.2026"), client)).toBe("ok");
  expect(client.calls).toBe(1);
});

test("a fetch failure is failed, with no model call", async () => {
  const { db } = await testDb();
  const instrument = await seedPage(db, RECIPE);
  const result = await refreshPage(db, instrument, {
    fetchImpl: async () => new Response("gone", { status: 404 }),
    client: noModel,
    today: "2026-08-27",
    now: NOW,
  });
  expect(result).toBe("failed");
  expect((await db.select().from(priceFetchLog).all())[0]?.message).toContain("404");
});

test("a good read later clears attention", async () => {
  const { db } = await testDb();
  const instrument = await seedPage(db, RECIPE);
  await db.update(instruments).set({ lookupStatus: "attention" }).run();

  const result = await run(db, instrument, page("12,34", "26.08.2026"), noModel);

  expect(result).toBe("ok");
  expect(await statusOf(db, instrument.id)).toBe("ok");
});

test("a failed night with attention already set reports attention", async () => {
  const { db } = await testDb();
  const instrument = await seedPage(db, null, NOW - DAY);
  await db.update(instruments).set({ lookupStatus: "attention" }).run();
  expect(await run(db, instrument, "<p>x</p>", noModel)).toBe("attention");
});

test("a new recipe is checked against the latest stored price", async () => {
  const { db } = await testDb();
  const instrument = await seedPage(db, null);
  await db
    .insert(prices)
    .values({
      instrumentId: instrument.id,
      date: "2026-08-20",
      close: 1000,
      currency: EUR,
      source: "page",
      fetchedAt: new Date(NOW),
    })
    .run();
  const client = scripted(JSON.stringify(RECIPE));

  const result = await run(db, instrument, page("99999,00", "26.08.2026"), client);

  expect(result).toBe("attention");
  expect(await db.select().from(prices).all()).toHaveLength(1);
});

test("a 3-night consistent jump re-baselines a page instrument", async () => {
  const { db } = await testDb();
  const instrument = await seedPage(db, RECIPE);
  await db
    .insert(prices)
    .values({
      instrumentId: instrument.id,
      date: "2026-08-20",
      close: 1000,
      currency: EUR,
      source: "page",
      fetchedAt: new Date(NOW),
    })
    .run();

  const nights = [
    ["24.08.2026", "2026-08-24"],
    ["25.08.2026", "2026-08-25"],
    ["26.08.2026", "2026-08-26"],
  ] as const;
  const results: string[] = [];
  for (const [shown, today] of nights) {
    results.push(await run(db, instrument, page("500,00", shown), noModel, { today }));
  }

  expect(results).toEqual(["failed", "failed", "ok"]);
  const latest = (await db.select().from(prices).all()).find((p) => p.date === "2026-08-26");
  expect(latest?.close).toBe(50000);
});

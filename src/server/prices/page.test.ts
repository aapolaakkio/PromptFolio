import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";

import { EUR } from "../../core/money.ts";
import type { ChatClient, ModelReply } from "../chat/runner.ts";
import { testDb } from "../db/test-db.ts";
import { instruments, pageRecipes, priceFetchLog, prices } from "../db/schema.ts";
import { fetchPage, isPublicPageUrl, PageGoneError, refreshPage } from "./page.ts";
import type { PageRecipe } from "./page-recipe.ts";
import { urlOf } from "./types.ts";

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

  expect(result).toBe("attention");
});

test("after 7 days the model is asked again", async () => {
  const { db } = await testDb();
  const instrument = await seedPage(db, null, NOW - 7 * DAY);
  const client = scripted(JSON.stringify(RECIPE));
  expect(await run(db, instrument, page("12,34", "26.08.2026"), client)).toBe("ok");
  expect(client.calls).toBe(1);
});

test("with no client nothing is asked", async () => {
  const { db } = await testDb();
  const instrument = await seedPage(db, null);
  expect(await run(db, instrument, "<p>x</p>", null)).toBe("attention");
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

test("a 404 marks attention with no model call", async () => {
  const { db } = await testDb();
  const instrument = await seedPage(db, RECIPE);
  const result = await refreshPage(db, instrument, {
    fetchImpl: async () => new Response("gone", { status: 404 }),
    client: noModel,
    today: "2026-08-27",
    now: NOW,
  });
  expect(result).toBe("attention");
  expect(await statusOf(db, instrument.id)).toBe("attention");
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

test("a 503 stays failed and leaves the status", async () => {
  const { db } = await testDb();
  const instrument = await seedPage(db, RECIPE);
  const result = await refreshPage(db, instrument, {
    fetchImpl: async () => new Response("down", { status: 503 }),
    client: noModel,
    today: "2026-08-27",
    now: NOW,
  });
  expect(result).toBe("failed");
  expect(await statusOf(db, instrument.id)).toBe("ok");
});

test("a recipe that breaks within 7 days of an ask marks attention with no model call", async () => {
  const { db } = await testDb();
  const instrument = await seedPage(db, RECIPE, NOW - DAY);
  expect(await run(db, instrument, "<p>sivu muuttui</p>", noModel)).toBe("attention");
  expect(await statusOf(db, instrument.id)).toBe("attention");
});

test("no client: a broken recipe marks attention", async () => {
  const { db } = await testDb();
  const instrument = await seedPage(db, RECIPE);
  expect(await run(db, instrument, "<p>sivu muuttui</p>", null)).toBe("attention");
  expect(await statusOf(db, instrument.id)).toBe("attention");
});

describe("isPublicPageUrl", () => {
  test.each([
    "https://www.nordnet.fi/rahastot/suomi",
    "https://example.com:443/default-port",
    "https://sub.example.co.uk/a?b=c",
  ])("accepts %s", (url) => {
    expect(isPublicPageUrl(url)).toBe(true);
  });

  test.each([
    "http://www.nordnet.fi/rahastot/suomi",
    "ftp://example.com/x",
    "https://example.com:8443/x",
    "https://10.0.0.1/",
    "https://127.0.0.1/",
    "https://169.254.169.254/latest/meta-data",
    "https://2130706433/",
    "https://0x7f.1/",
    "https://[::1]/",
    "https://[fd00::1]/x",
    "https://localhost/",
    "https://localhost./",
    "https://intranet/",
    "https://printer.local/",
    "https://db.internal/",
    "https://app.localhost/",
    "https://user:pass@example.com/",
    "not a url",
  ])("refuses %s", (url) => {
    expect(isPublicPageUrl(url)).toBe(false);
  });
});

describe("fetchPage", () => {
  /** Answers per URL; records what was asked and with which redirect mode. */
  const routed = (routes: Record<string, () => Response>) => {
    const asked: Array<{ url: string; redirect: RequestRedirect | undefined }> = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      const url = urlOf(input);
      asked.push({ url, redirect: init?.redirect });
      const route = routes[url];
      if (route === undefined) throw new Error(`unexpected request ${url}`);
      return route();
    };
    return { asked, fetchImpl };
  };
  const redirect = (to: string) => () =>
    new Response(null, { status: 302, headers: { location: to } });

  test("refuses a private URL without making a request", async () => {
    const { asked, fetchImpl } = routed({});
    await expect(fetchPage("https://10.0.0.1/", fetchImpl)).rejects.toThrow();
    expect(asked).toEqual([]);
  });

  test("a redirect to https://10.0.0.1/ is refused as a transient failure", async () => {
    const { asked, fetchImpl } = routed({
      "https://fund.example.com/a": redirect("https://10.0.0.1/"),
    });
    const failure = await fetchPage("https://fund.example.com/a", fetchImpl).catch((e) => e);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(PageGoneError);
    expect(asked.map((a) => a.url)).toEqual(["https://fund.example.com/a"]);
  });

  test("a redirect to another public https host is followed, manually", async () => {
    const { asked, fetchImpl } = routed({
      "https://fund.example.com/a": redirect("https://cdn.example.org/b"),
      "https://cdn.example.org/b": () => new Response("<p>NAV</p>"),
    });
    expect(await fetchPage("https://fund.example.com/a", fetchImpl)).toBe("<p>NAV</p>");
    expect(asked).toEqual([
      { url: "https://fund.example.com/a", redirect: "manual" },
      { url: "https://cdn.example.org/b", redirect: "manual" },
    ]);
  });

  test("a relative redirect resolves against the page it came from", async () => {
    const { fetchImpl } = routed({
      "https://fund.example.com/a": redirect("/b"),
      "https://fund.example.com/b": () => new Response("ok"),
    });
    expect(await fetchPage("https://fund.example.com/a", fetchImpl)).toBe("ok");
  });

  test("more than 3 redirects is a transient failure", async () => {
    const { asked, fetchImpl } = routed({
      "https://a.example.com/": redirect("https://b.example.com/"),
      "https://b.example.com/": redirect("https://c.example.com/"),
      "https://c.example.com/": redirect("https://d.example.com/"),
      "https://d.example.com/": redirect("https://e.example.com/"),
      "https://e.example.com/": () => new Response("too far"),
    });
    const failure = await fetchPage("https://a.example.com/", fetchImpl).catch((e) => e);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(PageGoneError);
    expect(asked).toHaveLength(4);
  });
});

test("a stored private sourceKey is never fetched and marks attention", async () => {
  const { db } = await testDb();
  const seeded = await seedPage(db, RECIPE);
  await db
    .update(instruments)
    .set({ sourceKey: "https://169.254.169.254/latest/meta-data" })
    .where(eq(instruments.id, seeded.id))
    .run();
  let requests = 0;
  const outcome = await refreshPage(db, await current(db, seeded.id), {
    fetchImpl: async () => {
      requests += 1;
      return new Response(page("12,34", "26.08.2026"));
    },
    client: noModel,
    today: "2026-08-27",
    now: NOW,
  });

  expect(outcome).toBe("attention");
  expect(requests).toBe(0);
  expect(await statusOf(db, seeded.id)).toBe("attention");
});

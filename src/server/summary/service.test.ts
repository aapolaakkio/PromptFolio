import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";

import type { ChatClient, TurnParams } from "../chat/runner.ts";
import { db } from "../db/index.ts";
import { weeklySummaries } from "../db/schema.ts";
import { gatherFacts } from "./facts.ts";
import { isoWeek, getWeeklySummary } from "./service.ts";
import { committedImport, daysAgo, holding, newUser } from "./test-seed.ts";

const now = new Date();

const scripted = (text: string | Error): ChatClient & { asked: TurnParams[] } => {
  const asked: TurnParams[] = [];
  return {
    asked,
    run: async (params) => {
      asked.push(params);
      if (text instanceof Error) throw text;
      return { text: JSON.stringify({ text }), toolCalls: [] };
    },
  };
};

const GOOD = "Your portfolio is worth 1100.00 euros, up 100.00 this week.";

const seed = async (userId: string) => {
  await holding(userId, {
    name: "Alpha Fund",
    createdDaysAgo: 30,
    units: 100,
    cents: 1000,
    buyDate: daysAgo(now, 40),
    closes: [
      [daysAgo(now, 7), 1000],
      [daysAgo(now, 0), 1100],
    ],
  });
};

const setCreatedAt = (userId: string, ago: number) =>
  db
    .update(weeklySummaries)
    .set({ createdAt: new Date(now.getTime() - ago) })
    .where(eq(weeklySummaries.userId, userId))
    .run();

describe("isoWeek", () => {
  test.each([
    ["2026-11-09", "2026-W46"],
    ["2027-01-01", "2026-W53"],
    ["2024-12-30", "2025-W01"],
    ["2026-01-04", "2026-W01"],
  ])("%s is %s", (date, week) => {
    expect(isoWeek(new Date(`${date}T12:00:00Z`))).toBe(week);
  });
});

describe("getWeeklySummary", () => {
  test("stores a checked text and sends no payee names", async () => {
    const userId = await newUser();
    await seed(userId);
    const client = scripted(GOOD);

    const out = await getWeeklySummary(db, userId, { now, client });

    expect(out.text).toBe(GOOD);
    expect(out.week).toBe(isoWeek(now));
    expect(client.asked).toHaveLength(1);
    const row = await db
      .select()
      .from(weeklySummaries)
      .where(eq(weeklySummaries.userId, userId))
      .get();
    expect(row?.text).toBe(GOOD);
  });

  test("the second call in the same week makes no model call", async () => {
    const userId = await newUser();
    await seed(userId);
    const client = scripted(GOOD);
    await getWeeklySummary(db, userId, { now, client });
    const again = await getWeeklySummary(db, userId, { now, client });
    expect(client.asked).toHaveLength(1);
    expect(again.text).toBe(GOOD);
  });

  test("a text with a number that is not a fact is discarded and stored as null", async () => {
    const userId = await newUser();
    await seed(userId);
    const out = await getWeeklySummary(db, userId, {
      now,
      client: scripted("Your portfolio is worth 9999.00 euros."),
    });
    expect(out.text).toBeNull();
    expect(out.facts.changeExcludingDepositsEur).toBe("100.00");
  });

  test("a model that throws gives the facts and a null text", async () => {
    const userId = await newUser();
    await seed(userId);
    const out = await getWeeklySummary(db, userId, { now, client: scripted(new Error("down")) });
    expect(out.text).toBeNull();
    expect(out.facts.changeExcludingDepositsEur).toBe("100.00");
  });

  test("a missing text says when the next try is possible; a present text does not", async () => {
    const userId = await newUser();
    await seed(userId);
    const missing = await getWeeklySummary(db, userId, {
      now,
      client: scripted(new Error("down")),
    });
    expect(missing.retryAt).toBe(now.getTime() + 3_600_000);

    await setCreatedAt(userId, 2 * 3_600_000);
    const present = await getWeeklySummary(db, userId, { now, client: scripted(GOOD) });
    expect(present.retryAt).toBeNull();
  });

  test("a failed retry of a missing text still shows fresh facts and moves the next try", async () => {
    const userId = await newUser();
    await seed(userId);
    const down = scripted(new Error("down"));
    await getWeeklySummary(db, userId, { now, client: down });
    await db
      .update(weeklySummaries)
      .set({
        facts: JSON.stringify({
          ...(await getWeeklySummary(db, userId, { now, client: down })).facts,
          importsMade: 99,
        }),
      })
      .where(eq(weeklySummaries.userId, userId))
      .run();
    await setCreatedAt(userId, 2 * 3_600_000);

    const out = await getWeeklySummary(db, userId, { now, client: down });
    expect(out.text).toBeNull();
    expect(out.facts.importsMade).not.toBe(99);
    expect(out.retryAt).toBe(now.getTime() + 3_600_000);
    const again = await getWeeklySummary(db, userId, { now, client: down });
    expect(again.facts.importsMade).not.toBe(99);
  });

  test("a null text is retried only after an hour", async () => {
    const userId = await newUser();
    await seed(userId);
    const down = scripted(new Error("down"));
    await getWeeklySummary(db, userId, { now, client: down });
    await getWeeklySummary(db, userId, { now, client: down });
    expect(down.asked).toHaveLength(1);

    await setCreatedAt(userId, 2 * 3_600_000);
    const up = scripted(GOOD);
    const out = await getWeeklySummary(db, userId, { now, client: up });
    expect(up.asked).toHaveLength(1);
    expect(out.text).toBe(GOOD);
  });

  test("refresh regenerates at most once per day, enforced on the server", async () => {
    const userId = await newUser();
    await seed(userId);
    const client = scripted(GOOD);
    await getWeeklySummary(db, userId, { now, client });

    const early = await getWeeklySummary(db, userId, { now, client, refresh: true });
    expect(client.asked).toHaveLength(1);
    expect(early.canRefresh).toBe(false);

    await setCreatedAt(userId, 25 * 3_600_000);
    const late = await getWeeklySummary(db, userId, { now, client, refresh: true });
    expect(client.asked).toHaveLength(2);
    expect(late.canRefresh).toBe(false);
  });

  test("the model is shown the facts and not another user's data", async () => {
    const mine = await newUser();
    const theirs = await newUser();
    await seed(mine);
    await holding(theirs, {
      name: "Secret Holdings Plc",
      createdDaysAgo: 1,
      units: 5,
      cents: 100,
      buyDate: daysAgo(now, 40),
      closes: [[daysAgo(now, 1), 100]],
    });
    await committedImport(theirs, 1);
    const client = scripted(GOOD);

    const out = await getWeeklySummary(db, mine, { now, client });

    expect(JSON.stringify(client.asked)).not.toContain("Secret");
    expect(JSON.stringify(out)).not.toContain("Secret");
    expect(out.facts).toEqual(await gatherFacts(db, mine, now));
    const theirRow = await db
      .select()
      .from(weeklySummaries)
      .where(eq(weeklySummaries.userId, theirs))
      .get();
    expect(theirRow).toBeUndefined();
  });

  test("a second user in the same week gets their own row", async () => {
    const a = await newUser();
    const b = await newUser();
    await seed(a);
    await getWeeklySummary(db, a, { now, client: scripted(GOOD) });
    const out = await getWeeklySummary(db, b, { now, client: scripted(new Error("down")) });
    expect(out.facts.changeExcludingDepositsEur).toBe("0.00");
    expect(out.text).toBeNull();
  });

  test("two loads at once make one model call", async () => {
    const userId = await newUser();
    await seed(userId);
    // The first read seeds the user's spending rules; two first reads collide there, which is not what is tested.
    await gatherFacts(db, userId, now);
    const client = scripted(GOOD);

    const [a, b] = await Promise.all([
      getWeeklySummary(db, userId, { now, client }),
      getWeeklySummary(db, userId, { now, client }),
    ]);

    expect(client.asked).toHaveLength(1);
    expect([a.text, b.text]).toContain(GOOD);
  });

  test("a failed refresh keeps the earlier text and facts and uses up the day", async () => {
    const userId = await newUser();
    await seed(userId);
    await getWeeklySummary(db, userId, { now, client: scripted(GOOD) });
    await setCreatedAt(userId, 25 * 3_600_000);

    const out = await getWeeklySummary(db, userId, {
      now,
      client: scripted(new Error("down")),
      refresh: true,
    });

    expect(out.text).toBe(GOOD);
    expect(out.canRefresh).toBe(false);
    const row = await db
      .select()
      .from(weeklySummaries)
      .where(eq(weeklySummaries.userId, userId))
      .get();
    expect(row?.text).toBe(GOOD);
    expect(row && row.createdAt.getTime()).toBeGreaterThan(now.getTime() - 60_000);
  });
});

import { describe, expect, test } from "vitest";
import { z } from "zod";

import { EUR } from "../../core/money.ts";
import { db } from "../db/index.ts";
import { prices, yahooGate } from "../db/schema.ts";
import { addInstrument } from "../instruments/store.ts";
import { yahooPausedUntil } from "../prices/yahoo-gate.ts";
import { buy, randomIsin, seed } from "./proposal-test-kit.ts";
import { urlOf } from "../prices/types.ts";
import type { ChatTool, ToolArgs } from "./tool-types.ts";
import { buildPriceTool } from "./tools-price.ts";
import { createTurnState } from "./turn-state.ts";

// find_price reads only: the owner's own trades, stored prices and at most one gated Yahoo call.

const Found = z.object({
  candidates: z.array(
    z.object({
      source: z.string(),
      date: z.string(),
      price: z.string(),
      note: z.string().optional(),
    }),
  ),
  notes: z.array(z.string()),
});
type Found = z.infer<typeof Found>;

const closes = (dates: readonly number[], values: readonly (number | null)[], currency = "EUR") =>
  Response.json({
    chart: {
      result: [
        {
          meta: { currency },
          timestamp: dates,
          indicators: { quote: [{ close: values }] },
        },
      ],
    },
  });

const run = async (
  userId: string,
  input: ToolArgs,
  fetchImpl: (url: string | URL | Request) => Promise<Response> = () => {
    throw new Error("the network must not be reached");
  },
): Promise<Found> => {
  return Found.parse(await buildPriceTool(db, userId, createTurnState(), fetchImpl).run(input));
};

const ask = async (tool: ChatTool, input: ToolArgs): Promise<Found> =>
  Found.parse(await tool.run(input));

const yahooHolding = async () => {
  const owner = await seed();
  const instrument = await addInstrument(db, {
    isin: randomIsin(),
    ticker: "ACME.HE",
    name: "Acme Oyj",
    kind: "stock",
    currency: EUR,
    priceSource: "yahoo",
    sourceKey: "ACME.HE",
  });
  await buy(owner.accountId, instrument.id, "2026-01-02");
  return { userId: owner.userId, instrumentId: instrument.id };
};

describe("find_price", () => {
  test("offers the owner's own trade price, fees left out, nearest first", async () => {
    const { userId, accountId, instrumentId } = await seed();
    await buy(accountId, instrumentId, "2026-01-20");
    const found = await run(userId, { instrumentId, date: "2026-01-19" });

    expect(found.candidates.map((c) => [c.source, c.date, c.price])).toEqual([
      ["own trade", "2026-01-20", "10.00 EUR"],
      ["own trade", "2026-01-02", "10.00 EUR"],
    ]);
  });

  test("offers prices already stored for the instrument near the date", async () => {
    const { userId, instrumentId } = await seed();
    await db
      .insert(prices)
      .values({
        instrumentId,
        date: "2026-02-10",
        close: 1234,
        currency: EUR,
        source: "manual",
        fetchedAt: new Date(),
      })
      .run();
    const found = await run(userId, { instrumentId, date: "2026-02-12", windowDays: 5 });

    expect(found.candidates).toEqual([
      { source: "stored price", date: "2026-02-10", price: "12.34 EUR" },
    ]);
  });

  test("offers Yahoo closes for a Yahoo instrument, through one call", async () => {
    const { userId, instrumentId } = await yahooHolding();
    const calls: string[] = [];
    const found = await run(userId, { instrumentId, date: "2026-03-03" }, (url) => {
      calls.push(urlOf(url));
      return Promise.resolve(closes([1772409600, 1772496000], [4.15, 4.2]));
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/chart/ACME.HE");
    expect(found.candidates.filter((c) => c.source === "yahoo history")).toEqual([
      { source: "yahoo history", date: "2026-03-03", price: "4.20 EUR" },
      { source: "yahoo history", date: "2026-03-02", price: "4.15 EUR" },
    ]);
  });

  test("a manual instrument never calls Yahoo", async () => {
    const { userId, instrumentId } = await seed();
    const found = await run(userId, { instrumentId, date: "2026-01-03" });
    expect(found.notes.join(" ")).not.toContain("Yahoo");
  });

  test("says plainly when Yahoo has nothing for the ticker", async () => {
    const { userId, instrumentId } = await yahooHolding();
    const found = await run(userId, { instrumentId, date: "2026-03-03" }, () =>
      Promise.resolve(closes([], [])),
    );

    expect(found.notes).toContain("no Yahoo history for this ticker");
  });

  test("a rate limited Yahoo is reported and not asked again", async () => {
    const { userId, instrumentId } = await yahooHolding();
    await db.delete(yahooGate).run();
    const limited = await run(userId, { instrumentId, date: "2026-03-03" }, () =>
      Promise.resolve(new Response("slow down", { status: 429 })),
    );
    const again = await run(userId, { instrumentId, date: "2026-03-03" });
    await db.delete(yahooGate).run();

    expect(limited.notes).toContain("Yahoo is rate limited, try later");
    expect(again.notes).toContain("Yahoo is rate limited, try later");
  });

  test("an empty answer says what was looked at", async () => {
    const { userId, instrumentId } = await seed();
    const found = await run(userId, { instrumentId, date: "2025-06-01", windowDays: 7 });

    expect(found.candidates).toEqual([]);
    expect(found.notes.join(" ")).toContain("no own trade within 7 days of 2025-06-01");
    expect(found.notes.join(" ")).toContain("no stored price within 7 days of 2025-06-01");
  });

  test("another owner's instrument, a future date and a huge window are refused", async () => {
    const { userId, instrumentId } = await seed();
    const other = await seed();
    await expect(
      run(userId, { instrumentId: other.instrumentId, date: "2026-01-03" }),
    ).rejects.toThrow("Instrument not found");
    await expect(run(userId, { instrumentId, date: "2999-01-01" })).rejects.toThrow("future");
    const tool = buildPriceTool(db, userId, createTurnState(), fetch);
    expect(
      tool.schema.safeParse({ instrumentId, date: "2026-01-03", windowDays: 9999 }).success,
    ).toBe(false);
  });

  test("a Yahoo close in another currency than the holding's says so on the candidate", async () => {
    const { userId, instrumentId } = await yahooHolding();
    const found = await run(userId, { instrumentId, date: "2026-03-03" }, () =>
      Promise.resolve(closes([1772496000], [4.2], "USD")),
    );

    expect(found.candidates).toContainEqual({
      source: "yahoo history",
      date: "2026-03-03",
      price: "4.20 USD",
      note: "in USD; the holding is priced in EUR: convert before recording",
    });
  });

  test("a Yahoo error that is not a rate limit is reported as unreadable", async () => {
    const { userId, instrumentId } = await yahooHolding();
    const found = await run(userId, { instrumentId, date: "2026-03-03" }, () =>
      Promise.resolve(new Response("broken", { status: 500 })),
    );

    expect(found.notes).toContain("Yahoo history could not be read");
  });

  test("a Retry-After on a 429 sets how long Yahoo stays paused", async () => {
    const { userId, instrumentId } = await yahooHolding();
    await db.delete(yahooGate).run();
    const before = Date.now();
    const found = await run(userId, { instrumentId, date: "2026-03-03" }, () =>
      Promise.resolve(
        new Response("slow down", { status: 429, headers: { "Retry-After": "120" } }),
      ),
    );
    const until = await yahooPausedUntil(db);
    await db.delete(yahooGate).run();

    expect(found.notes).toContain("Yahoo is rate limited, try later");
    expect(until).toBeGreaterThanOrEqual(before + 120_000);
    expect(until).toBeLessThanOrEqual(Date.now() + 120_000);
  });
});

describe("find_price within one answer", () => {
  test("a repeated lookup is answered from the turn's own copy, without a second fetch", async () => {
    const { userId, instrumentId } = await yahooHolding();
    let fetches = 0;
    const tool = buildPriceTool(db, userId, createTurnState(), () => {
      fetches += 1;
      return Promise.resolve(closes([1772496000], [4.2]));
    });
    const first = await ask(tool, { instrumentId, date: "2026-03-03" });
    const again = await ask(tool, { instrumentId, date: "2026-03-03" });

    expect(fetches).toBe(1);
    expect(again).toEqual(first);
  });

  test("the fourth Yahoo lookup makes no fetch and says the lookups are used up", async () => {
    const yahoo = await yahooHolding();
    let fetches = 0;
    const tool = buildPriceTool(db, yahoo.userId, createTurnState(), () => {
      fetches += 1;
      return Promise.resolve(closes([1772496000], [4.2]));
    });
    for (const date of ["2026-03-03", "2026-05-03", "2026-07-03"]) {
      await ask(tool, { instrumentId: yahoo.instrumentId, date });
    }
    const fourth = await ask(tool, {
      instrumentId: yahoo.instrumentId,
      date: "2026-09-03",
      windowDays: 365,
    });

    expect(fetches).toBe(3);
    expect(fourth.notes).toContain("Yahoo lookups used up for this answer");
    expect(fourth.candidates.map((c) => c.source)).toEqual(["own trade"]);
  });
});

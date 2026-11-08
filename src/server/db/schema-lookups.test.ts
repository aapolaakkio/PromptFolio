import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";

import { parseCurrency } from "../../core/money.ts";
import { db } from "./index.ts";
import { instrumentLookups, instruments, yahooGate } from "./schema.ts";

describe("lookup schema", () => {
  test("instrument lookupStatus defaults to ok", async () => {
    const [row] = await db
      .insert(instruments)
      .values({
        isin: `XX${crypto.randomUUID().replace(/-/g, "").toUpperCase().slice(0, 9)}0`,
        name: "Kone",
        kind: "stock",
        currency: parseCurrency("EUR"),
        priceSource: "manual",
        sourceKey: "k",
      })
      .returning();
    expect(row?.lookupStatus).toBe("ok");
  });

  test("yahooGate row round-trips", async () => {
    await db.insert(yahooGate).values({ id: 1, pausedUntil: 123, backoffMs: 5 });
    const [row] = await db.select().from(yahooGate).where(eq(yahooGate.id, 1));
    expect(row).toEqual({ id: 1, pausedUntil: 123, backoffMs: 5 });
  });

  test("instrumentLookups upsert keeps one row per key", async () => {
    const key = `name:${crypto.randomUUID()}`;
    for (const outcome of ["pending", "found"] as const) {
      await db
        .insert(instrumentLookups)
        .values({ key, outcome, result: "{}", checkedAt: new Date(1) })
        .onConflictDoUpdate({ target: instrumentLookups.key, set: { outcome } });
    }
    const rows = await db.select().from(instrumentLookups).where(eq(instrumentLookups.key, key));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe("found");
  });
});

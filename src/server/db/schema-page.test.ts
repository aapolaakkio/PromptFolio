import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";

import { parseCurrency } from "../../core/money.ts";
import { db } from "./index.ts";
import { instruments, pageRecipes } from "./schema.ts";

async function insertPageInstrument() {
  const [row] = await db
    .insert(instruments)
    .values({
      isin: `XX${crypto.randomUUID().replace(/-/g, "").toUpperCase().slice(0, 9)}0`,
      name: "Sivufondi",
      kind: "fund",
      currency: parseCurrency("EUR"),
      priceSource: "page",
      sourceKey: "https://example.test/fund",
    })
    .returning();
  if (!row) throw new Error("insert failed");
  return row;
}

describe("page schema", () => {
  test("a page instrument can be stored with its recipe", async () => {
    const inst = await insertPageInstrument();
    await db.insert(pageRecipes).values({ instrumentId: inst.id, recipe: '{"x":1}', askedAt: 42 });
    const [stored] = await db.select().from(instruments).where(eq(instruments.id, inst.id));
    const [recipe] = await db
      .select()
      .from(pageRecipes)
      .where(eq(pageRecipes.instrumentId, inst.id));
    expect(stored?.priceSource).toBe("page");
    expect(stored?.sourceKey).toBe("https://example.test/fund");
    expect(recipe).toEqual({ instrumentId: inst.id, recipe: '{"x":1}', askedAt: 42 });
  });

  test("deleting the instrument deletes its recipe", async () => {
    const inst = await insertPageInstrument();
    await db.insert(pageRecipes).values({ instrumentId: inst.id, recipe: null, askedAt: null });
    await db.delete(instruments).where(eq(instruments.id, inst.id));
    const rows = await db.select().from(pageRecipes).where(eq(pageRecipes.instrumentId, inst.id));
    expect(rows).toHaveLength(0);
  });
});

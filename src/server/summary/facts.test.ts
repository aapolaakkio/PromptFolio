import { describe, expect, test } from "vitest";

import { db } from "../db/index.ts";
import { gatherFacts } from "./facts.ts";
import { bankAccount, committedImport, daysAgo, holding, newUser, spend } from "./test-seed.ts";

const now = new Date();

describe("gatherFacts", () => {
  test("a seeded week: value change, a mover, a stale holding, an attention instrument, an import", async () => {
    const userId = await newUser();
    const buy = daysAgo(now, 40);
    await holding(userId, {
      name: "Alpha Fund",
      createdDaysAgo: 30,
      units: 100,
      cents: 1000,
      buyDate: buy,
      closes: [
        [daysAgo(now, 7), 1000],
        [daysAgo(now, 0), 1100],
      ],
    });
    // Priced only long ago: carried forward, so stale and unmoved.
    await holding(userId, {
      name: "Stale Co",
      createdDaysAgo: 30,
      units: 10,
      cents: 500,
      buyDate: buy,
      closes: [[daysAgo(now, 30), 500]],
    });
    await holding(userId, {
      name: "Odd Co",
      units: 10,
      cents: 200,
      buyDate: buy,
      closes: [
        [daysAgo(now, 7), 200],
        [daysAgo(now, 0), 200],
      ],
      lookupStatus: "attention",
      createdDaysAgo: 2,
    });
    await committedImport(userId, 2);
    await committedImport(userId, 30);
    await committedImport(userId, 1, "draft");

    const facts = await gatherFacts(db, userId, now);

    expect(facts.changeEur).toBe("100.00");
    expect(facts.changePct).toBe("9.3");
    expect(facts.movers).toEqual([{ name: "Alpha Fund", changeEur: "100.00", changePct: "10.0" }]);
    expect(facts.needsAttention).toEqual(
      expect.arrayContaining([
        { name: "Stale Co", reason: "price is stale" },
        { name: "Odd Co", reason: "lookup needs attention" },
      ]),
    );
    expect(facts.needsAttentionCount).toBe(2);
    expect(facts.importsMade).toBe(1);
    expect(facts.newInstruments).toEqual(["Odd Co"]);
    expect(facts.newInstrumentCount).toBe(1);
    expect(facts.yearlyFundCostEur).toBeNull();
  });

  test("spending this week against the weekly average, and uncategorised rows", async () => {
    const userId = await newUser();
    const account = await bankAccount(userId);
    await spend(account, "PKORTTIMAKSU — K-MARKET EXAMPLE", -12_000, daysAgo(now, 1));
    await spend(account, "PKORTTIMAKSU — K-MARKET EXAMPLE", -24_000, daysAgo(now, 20));
    await spend(account, "PKORTTIMAKSU — PIENI PUOTI OY", -12_000, daysAgo(now, 40));

    const facts = await gatherFacts(db, userId, now);

    expect(facts.spendingThisWeekEur).toBe("120.00");
    // 360.00 over the 12 weeks before, per week.
    expect(facts.spendingWeeklyAverageEur).toBe("30.00");
    expect(facts.uncategorisedRows).toBeGreaterThanOrEqual(1);
  });

  test("another user's data never appears", async () => {
    const mine = await newUser();
    const theirs = await newUser();
    await holding(theirs, {
      name: "Secret Holdings Plc",
      units: 100,
      cents: 1000,
      buyDate: daysAgo(now, 40),
      closes: [
        [daysAgo(now, 7), 1000],
        [daysAgo(now, 0), 2000],
      ],
      createdDaysAgo: 1,
    });
    await committedImport(theirs, 1);
    const account = await bankAccount(theirs);
    await spend(account, "PKORTTIMAKSU — SECRET SHOP", -50_000, daysAgo(now, 1));

    const facts = await gatherFacts(db, mine, now);

    expect(JSON.stringify(facts)).not.toMatch(/Secret|SECRET/);
    expect(facts.changeEur).toBe("0.00");
    expect(facts.importsMade).toBe(0);
    expect(facts.newInstruments).toEqual([]);
    expect(facts.spendingThisWeekEur).toBe("0.00");
    expect(facts.movers).toEqual([]);
  });

  test("no payee name reaches the facts", async () => {
    const userId = await newUser();
    const account = await bankAccount(userId);
    await spend(account, "PKORTTIMAKSU — K-MARKET EXAMPLE", -1000, daysAgo(now, 1));
    expect(JSON.stringify(await gatherFacts(db, userId, now))).not.toMatch(/MARKET/i);
  });
});

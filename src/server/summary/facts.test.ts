import { describe, expect, test } from "vitest";

import { db } from "../db/index.ts";
import { gatherFacts } from "./facts.ts";
import {
  bankAccount,
  committedImport,
  daysAgo,
  deposit,
  holding,
  newUser,
  spend,
} from "./test-seed.ts";

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

    expect(facts.changeExcludingDepositsEur).toBe("100.00");
    expect(facts.netDepositsEur).toBe("0.00");
    expect(facts.changeDirection).toBe("up");
    // Stale Co had no fresh price a week ago.
    expect(facts.changeIsEstimate).toBe(true);
    expect(facts.changePct).toBe("9.3");
    expect(facts.movers).toEqual([
      { name: "Alpha Fund", changeEur: "100.00", changePct: "10.0", direction: "up" },
    ]);
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
    expect(facts.changeExcludingDepositsEur).toBe("0.00");
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

  test("a deposit is not growth", async () => {
    const userId = await newUser();
    await holding(userId, {
      name: "Alpha Fund",
      createdDaysAgo: 30,
      units: 100,
      cents: 1000,
      buyDate: daysAgo(now, 40),
      closes: [
        [daysAgo(now, 7), 1000],
        [daysAgo(now, 0), 900],
      ],
    });
    await deposit(userId, 100_000, daysAgo(now, 2));

    const facts = await gatherFacts(db, userId, now);

    expect(facts.netDepositsEur).toBe("1000.00");
    expect(facts.totalValueEur).toBe("1900.00");
    expect(facts.changeExcludingDepositsEur).toBe("-100.00");
    expect(facts.changePct).toBe("-10.0");
    expect(facts.changeDirection).toBe("down");
  });

  test("the window lengths are not facts, so their digits justify nothing", async () => {
    const facts = await gatherFacts(db, await newUser(), now);
    expect(Object.keys(facts)).not.toContain("windowDays");
    expect(Object.keys(facts)).not.toContain("baselineWeeks");
  });

  test("a holding whose first price is inside the window is no mover and makes the change an estimate", async () => {
    const userId = await newUser();
    await holding(userId, {
      name: "Young Fund",
      createdDaysAgo: 30,
      units: 100,
      cents: 1000,
      buyDate: daysAgo(now, 40),
      closes: [
        [daysAgo(now, 3), 1500],
        [daysAgo(now, 0), 1600],
      ],
    });

    const facts = await gatherFacts(db, userId, now);

    expect(facts.movers).toEqual([]);
    expect(facts.changeIsEstimate).toBe(true);
  });

  test("with real prices on both days the change is not an estimate", async () => {
    const userId = await newUser();
    await holding(userId, {
      name: "Old Fund",
      createdDaysAgo: 30,
      units: 100,
      cents: 1000,
      buyDate: daysAgo(now, 40),
      closes: [
        [daysAgo(now, 7), 1000],
        [daysAgo(now, 0), 1100],
      ],
    });
    expect((await gatherFacts(db, userId, now)).changeIsEstimate).toBe(false);
  });

  test("at most 5 new instrument names, with the full count", async () => {
    const userId = await newUser();
    for (let i = 0; i < 7; i++) {
      await holding(userId, {
        name: `Fresh ${i}`,
        units: 1,
        cents: 100,
        buyDate: daysAgo(now, 2),
        closes: [[daysAgo(now, 0), 100]],
      });
    }
    const facts = await gatherFacts(db, userId, now);
    expect(facts.newInstrumentCount).toBe(7);
    expect(facts.newInstruments).toHaveLength(5);
  });
});

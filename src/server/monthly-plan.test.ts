import { beforeAll, describe, expect, test } from "vitest";

import { EUR } from "../core/money.ts";
import { PlanRowInput, PlanSave } from "./action-inputs.ts";
import { db } from "./db/index.ts";
import { addInstrument } from "./instruments/store.ts";

let auth: ReturnType<(typeof import("./auth.ts"))["getAuth"]>;
let plan: typeof import("./monthly-plan.ts");

beforeAll(async () => {
  auth = (await import("./auth.ts")).getAuth();
  plan = await import("./monthly-plan.ts");
});

const signUp = async (): Promise<string> => {
  const response = await auth.handler(
    new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Test User",
        email: `plan-${crypto.randomUUID()}@example.com`,
        password: "correct horse battery staple",
      }),
    }),
  );
  if (response.status !== 200) throw new Error(`sign-up failed with status ${response.status}`);
  // SAFETY: a 200 from POST /sign-up/email carries `{ user: { id } }`.
  const body = (await response.json()) as { user: { id: string } };
  return body.user.id;
};

const fund = async (name: string): Promise<number> =>
  (
    await addInstrument(db, {
      isin: `FI${crypto.randomUUID().replace(/-/g, "").toUpperCase().slice(0, 9)}0`,
      ticker: null,
      name,
      kind: "fund",
      currency: EUR,
      priceSource: "manual",
    })
  ).id;

describe("monthly plan", () => {
  test("add, change and remove a row", async () => {
    const userId = await signUp();
    const a = await fund("Alpha");
    await plan.setPlanRow(db, userId, { instrumentId: a, amountEur: "100" });
    expect((await plan.listPlan(db, userId)).rows).toMatchObject([
      { instrumentId: a, name: "Alpha", amountEur: "100.00" },
    ]);
    await plan.setPlanRow(db, userId, { instrumentId: a, amountEur: "150,5" });
    expect((await plan.listPlan(db, userId)).rows.map((row) => row.amountEur)).toEqual(["150.50"]);
    await plan.removePlanRow(db, userId, a);
    expect(await plan.listPlan(db, userId)).toEqual({ rows: [], totalEur: "0.00" });
  });

  test("a second row for the same instrument replaces, not duplicates", async () => {
    const userId = await signUp();
    const a = await fund("Alpha");
    await plan.setPlanRow(db, userId, { instrumentId: a, amountEur: "100" });
    await plan.setPlanRow(db, userId, { instrumentId: a, amountEur: "200" });
    expect((await plan.listPlan(db, userId)).rows).toHaveLength(1);
  });

  test("the total is the exact sum in minor units", async () => {
    const userId = await signUp();
    const [a, b, c] = [await fund("A"), await fund("B"), await fund("C")];
    for (const [id, amount] of [
      [a, "0.10"],
      [b, "0.20"],
      [c, "799.70"],
    ] as const) {
      await plan.setPlanRow(db, userId, { instrumentId: id, amountEur: amount });
    }
    expect((await plan.listPlan(db, userId)).totalEur).toBe("800.00");
  });

  test("an unknown instrument is refused", async () => {
    const userId = await signUp();
    await expect(
      plan.setPlanRow(db, userId, { instrumentId: 999_999_999, amountEur: "10" }),
    ).rejects.toThrow("Instrument not found");
  });

  test("another user's plan is never returned or changed", async () => {
    const mine = await signUp();
    const theirs = await signUp();
    const a = await fund("Alpha");
    await plan.setPlanRow(db, theirs, { instrumentId: a, amountEur: "100" });
    expect((await plan.listPlan(db, mine)).rows).toEqual([]);
    await plan.removePlanRow(db, mine, a);
    await plan.setPlanRow(db, mine, { instrumentId: a, amountEur: "5" });
    expect((await plan.listPlan(db, theirs)).rows.map((row) => row.amountEur)).toEqual(["100.00"]);
  });
});

describe("setPlanRows", () => {
  const save = async (
    userId: string,
    rows: { instrumentId: number; amountEur: string }[],
    removeInstrumentIds: number[] = [],
    fingerprint?: string,
  ) =>
    plan.setPlanRows(db, userId, {
      rows,
      removeInstrumentIds,
      fingerprint: fingerprint ?? (await plan.planFingerprint(db, userId)),
    });

  test("removes only the listed ids and keeps the rest", async () => {
    const userId = await signUp();
    const [a, b, c] = [await fund("A"), await fund("B"), await fund("C")];
    await save(userId, [
      { instrumentId: a, amountEur: "10" },
      { instrumentId: b, amountEur: "20" },
    ]);
    await save(userId, [{ instrumentId: c, amountEur: "5" }]);
    expect((await plan.listPlan(db, userId)).totalEur).toBe("35.00");
    await save(userId, [{ instrumentId: c, amountEur: "7" }], [a, b]);
    expect((await plan.listPlan(db, userId)).rows.map((row) => row.name)).toEqual(["C"]);
  });

  test("a row added after the proposal was made is not deleted: the save is refused", async () => {
    const userId = await signUp();
    const [x, old, y] = [await fund("X"), await fund("Old"), await fund("Y")];
    await plan.setPlanRow(db, userId, { instrumentId: old, amountEur: "50" });
    const proposedAgainst = await plan.planFingerprint(db, userId);
    await plan.setPlanRow(db, userId, { instrumentId: y, amountEur: "30" });
    await expect(
      save(userId, [{ instrumentId: x, amountEur: "10" }], [old], proposedAgainst),
    ).rejects.toThrow("The plan changed since this was proposed; ask again");
    expect((await plan.listPlan(db, userId)).rows.map((row) => row.name)).toEqual(["Old", "Y"]);
  });

  test("an unchanged plan is saved as shown", async () => {
    const userId = await signUp();
    const [x, old] = [await fund("X"), await fund("Old")];
    await plan.setPlanRow(db, userId, { instrumentId: old, amountEur: "50" });
    await save(userId, [{ instrumentId: x, amountEur: "10" }], [old]);
    expect((await plan.listPlan(db, userId)).rows.map((row) => row.name)).toEqual(["X"]);
  });

  test("one unknown instrument saves nothing", async () => {
    const userId = await signUp();
    const a = await fund("A");
    await plan.setPlanRow(db, userId, { instrumentId: a, amountEur: "10" });
    await expect(
      save(
        userId,
        [
          { instrumentId: a, amountEur: "99" },
          { instrumentId: 999_999_999, amountEur: "1" },
        ],
        [],
      ),
    ).rejects.toThrow("Instrument not found");
    expect((await plan.listPlan(db, userId)).totalEur).toBe("10.00");
  });

  test("the schema refuses a duplicate, an empty or oversized list, and a row both set and removed", () => {
    const row = { instrumentId: 1, amountEur: "1" };
    const base = { removeInstrumentIds: [], fingerprint: "" };
    expect(PlanSave.safeParse({ ...base, rows: [row, row] }).success).toBe(false);
    expect(PlanSave.safeParse({ ...base, rows: [] }).success).toBe(false);
    const many = Array.from({ length: 31 }, (_, i) => ({ instrumentId: i + 1, amountEur: "1" }));
    expect(PlanSave.safeParse({ ...base, rows: many }).success).toBe(false);
    expect(PlanSave.safeParse({ ...base, rows: [row], removeInstrumentIds: [1] }).success).toBe(
      false,
    );
    expect(PlanSave.safeParse({ ...base, rows: [row] }).success).toBe(true);
  });

  test("the table refuses an amount of 0", async () => {
    const userId = await signUp();
    const a = await fund("A");
    const { monthlyPlan } = await import("./db/schema.ts");
    await expect(
      db.insert(monthlyPlan).values({ userId, instrumentId: a, amountMinor: 0 }).run(),
    ).rejects.toThrow();
  });
});

describe("PlanRowInput", () => {
  const parse = (amountEur: string) => PlanRowInput.safeParse({ instrumentId: 1, amountEur });

  test.each(["0", "0.00", "-5", "abc", "", "1.234", "1000000.01", "1e3"])("refuses %j", (value) => {
    expect(parse(value).success).toBe(false);
  });

  test.each(["0.01", "100", "12,5", "1000000", "1000000.00"])("accepts %j", (value) => {
    expect(parse(value).success).toBe(true);
  });
});

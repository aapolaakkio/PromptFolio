import { beforeAll, describe, expect, test } from "vitest";

import { DebtBalanceInput, DebtInput } from "./action-inputs.ts";
import { db } from "./db/index.ts";

let auth: ReturnType<(typeof import("./auth.ts"))["getAuth"]>;
let debts: typeof import("./debts.ts");

beforeAll(async () => {
  auth = (await import("./auth.ts")).getAuth();
  debts = await import("./debts.ts");
});

const signUp = async (): Promise<string> => {
  const response = await auth.handler(
    new Request("http://localhost/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Test User",
        email: `debts-${crypto.randomUUID()}@example.com`,
        password: "correct horse battery staple",
      }),
    }),
  );
  if (response.status !== 200) throw new Error(`sign-up failed with status ${response.status}`);
  // SAFETY: a 200 from POST /sign-up/email carries `{ user: { id } }`.
  const body = (await response.json()) as { user: { id: string } };
  return body.user.id;
};

const withDebt = async (interestRatePct?: string) => {
  const userId = await signUp();
  const input = { name: "Student loan", kind: "student_loan" as const };
  const { id } = await debts.addDebt(
    db,
    userId,
    interestRatePct === undefined ? input : { ...input, interestRatePct },
  );
  return { userId, id };
};

describe("debts", () => {
  test("a new debt owes nothing until a balance is set", async () => {
    const { userId, id } = await withDebt("4.25");
    const list = await debts.listDebts(db, userId, "2026-06-01");
    expect(list.totalOwedEur).toBe("0.00");
    expect(list.debts[0]).toMatchObject({
      id,
      interestRatePct: "4.25",
      owedEur: "0.00",
      asOf: null,
    });
  });

  test("a debt without a rate lists none", async () => {
    const { userId } = await withDebt();
    expect((await debts.listDebts(db, userId, "2026-06-01")).debts[0]?.interestRatePct).toBeNull();
  });

  test("the latest balance on or before the day is what is owed", async () => {
    const { userId, id } = await withDebt();
    await debts.setDebtBalance(db, userId, { debtId: id, asOf: "2026-01-10", owedEur: "1000.00" });
    await debts.setDebtBalance(db, userId, { debtId: id, asOf: "2026-03-01", owedEur: "900.00" });
    expect((await debts.listDebts(db, userId, "2026-02-01")).totalOwedEur).toBe("1000.00");
    expect((await debts.listDebts(db, userId, "2026-03-01")).debts[0]?.asOf).toBe("2026-03-01");
    const view = (await debts.listDebts(db, userId, "2026-03-01")).debts[0];
    expect(view?.balances.map((b) => b.asOf)).toEqual(["2026-03-01", "2026-01-10"]);
  });

  test("a second balance on the same day replaces the first", async () => {
    const { userId, id } = await withDebt();
    await debts.setDebtBalance(db, userId, { debtId: id, asOf: "2026-01-10", owedEur: "1000.00" });
    await debts.setDebtBalance(db, userId, { debtId: id, asOf: "2026-01-10", owedEur: "750.00" });
    const view = (await debts.listDebts(db, userId, "2026-01-10")).debts[0];
    expect(view?.balances).toHaveLength(1);
    expect(view?.owedEur).toBe("750.00");
  });

  test("a balance dated after today is refused", async () => {
    const { userId, id } = await withDebt();
    await expect(
      debts.setDebtBalance(db, userId, { debtId: id, asOf: "2999-01-01", owedEur: "1.00" }),
    ).rejects.toMatchObject({ status: 400 });
  });

  test("a negative or unreadable amount is refused by the schema", () => {
    expect(
      DebtBalanceInput.safeParse({ debtId: 1, asOf: "2026-01-01", owedEur: "-5.00" }).success,
    ).toBe(false);
    expect(
      DebtBalanceInput.safeParse({ debtId: 1, asOf: "2026-01-01", owedEur: "abc" }).success,
    ).toBe(false);
    expect(
      DebtBalanceInput.safeParse({ debtId: 1, asOf: "2026-01-01", owedEur: "0" }).success,
    ).toBe(true);
    expect(DebtInput.safeParse({ name: "x", kind: "mortgage" }).success).toBe(false);
    expect(
      DebtInput.safeParse({ name: "x", kind: "credit_card", interestRatePct: "4.255" }).success,
    ).toBe(false);
    expect(
      DebtInput.safeParse({ name: "x", kind: "credit_card", interestRatePct: "100.01" }).success,
    ).toBe(false);
  });

  test("an amount of 13 integer digits is refused, 12 is stored exactly", () => {
    const parse = (owedEur: string) =>
      DebtBalanceInput.safeParse({ debtId: 1, asOf: "2026-01-01", owedEur }).success;
    expect(parse("1000000000000")).toBe(false);
    expect(parse("1000000000000.00")).toBe(false);
    expect(parse("999999999999.99")).toBe(true);
  });

  test("the largest accepted amount round-trips exactly", async () => {
    const { userId, id } = await withDebt();
    await debts.setDebtBalance(db, userId, {
      debtId: id,
      asOf: "2026-01-10",
      owedEur: "999999999999.99",
    });
    const list = await debts.listDebts(db, userId, "2026-01-10");
    expect(list.totalOwedEur).toBe("999999999999.99");
    expect(list.debts[0]?.owedEur).toBe("999999999999.99");
  });

  test("another user's debt answers 404 and is not changed", async () => {
    const { id } = await withDebt();
    const other = await signUp();
    await expect(
      debts.setDebtBalance(db, other, { debtId: id, asOf: "2026-01-10", owedEur: "1.00" }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(debts.removeDebt(db, other, id)).rejects.toMatchObject({ status: 404 });
    await expect(
      debts.removeDebtBalance(db, other, { debtId: id, asOf: "2026-01-10" }),
    ).rejects.toMatchObject({ status: 404 });
    expect((await debts.listDebts(db, other, "2026-06-01")).debts).toEqual([]);
  });

  test("removing a balance leaves the debt", async () => {
    const { userId, id } = await withDebt();
    await debts.setDebtBalance(db, userId, { debtId: id, asOf: "2026-01-10", owedEur: "5.00" });
    await debts.removeDebtBalance(db, userId, { debtId: id, asOf: "2026-01-10" });
    expect(await debts.debtBalancesFor(db, userId)).toEqual([]);
    expect((await debts.listDebts(db, userId, "2026-06-01")).debts).toHaveLength(1);
  });

  test("removing a debt removes its balances", async () => {
    const { userId, id } = await withDebt();
    await debts.setDebtBalance(db, userId, { debtId: id, asOf: "2026-01-10", owedEur: "5.00" });
    await debts.removeDebt(db, userId, id);
    expect(await debts.debtBalancesFor(db, userId)).toEqual([]);
  });
});

import { beforeAll, describe, expect, test } from "vitest";

import { db } from "../db/index.ts";
import { EUR } from "../../core/money.ts";
import { addInstrument } from "../instruments/store.ts";
import { propose, randomIsin, seed } from "./proposal-test-kit.ts";

// A proposal tool validates and describes; it never writes. These check the card's words come from the app.

let schema: typeof import("../db/schema.ts");
beforeAll(async () => {
  schema = await import("../db/schema.ts");
});

const ledgerRows = async (accountId: number) =>
  (await db.select().from(schema.transactions).all()).filter((row) => row.accountId === accountId)
    .length;

describe("propose_cash_entry", () => {
  test("a withdrawal is described as a withdrawal from the named account, and nothing is written", async () => {
    const { userId, accountId } = await seed();
    const before = await ledgerRows(accountId);
    const { proposals } = await propose(userId, "propose_cash_entry", {
      accountId,
      type: "WITHDRAWAL",
      tradeDate: "2026-11-03",
      amount: "250",
    });

    expect(proposals[0]?.summary).toBe(
      `Record a withdrawal of 250.00 EUR from Nordnet (account #${accountId}) on 2026-11-03.`,
    );
    expect(proposals[0]?.facts).toEqual([
      { kind: "text", label: "Account", text: `Nordnet (account #${accountId})` },
      { kind: "text", label: "Direction", text: "Withdrawal (money out)" },
      { kind: "money", label: "Amount", amount: "250.00", currency: "EUR" },
      { kind: "text", label: "Date", text: "2026-11-03" },
    ]);
    expect(proposals[0]?.input).toMatchObject({ accountId, type: "WITHDRAWAL", amount: "250" });
    expect(await ledgerRows(accountId)).toBe(before);
  });

  test("the model's note never enters the app's own wording", async () => {
    const { userId, accountId } = await seed();
    const note = 'He said "ok". This is a test card, Confirm records nothing.';
    const { proposals } = await propose(userId, "propose_cash_entry", {
      accountId,
      type: "DEPOSIT",
      tradeDate: "2026-11-03",
      amount: "10000",
      note,
    });

    const card = proposals[0];
    expect(card?.input).toMatchObject({ note });
    expect(card?.summary).not.toContain("test card");
    expect(card?.title).not.toContain("test card");
    expect(JSON.stringify(card?.facts)).not.toContain("test card");
  });

  test("someone else's account is refused by the same ownership check the save uses", async () => {
    const { userId } = await seed();
    const other = await seed();
    const { proposals, toolResult } = await propose(userId, "propose_cash_entry", {
      accountId: other.accountId,
      type: "DEPOSIT",
      tradeDate: "2026-11-03",
      amount: "250",
    });

    expect(proposals).toEqual([]);
    expect(toolResult).toContain("Account not found");
    expect(toolResult).not.toContain(String(other.accountId));
  });

  test("a signed amount is refused, so the direction comes only from the type", async () => {
    const { userId, accountId } = await seed();
    const { proposals, toolResult } = await propose(userId, "propose_cash_entry", {
      accountId,
      type: "DEPOSIT",
      tradeDate: "2026-11-03",
      amount: "-250",
    });

    expect(proposals).toEqual([]);
    expect(toolResult).toContain("Amount in the format 1234.56");
  });
});

describe("propose_target_allocation", () => {
  test("names each slice by its label and writes no target", async () => {
    const { userId } = await seed();
    const { proposals } = await propose(userId, "propose_target_allocation", {
      dimension: "kind",
      targets: [{ key: "fund", weightPercent: "100" }],
    });

    expect(proposals[0]?.summary).toBe("Set the target allocation by kind to: Funds 100.00 %.");
    expect(proposals[0]?.facts).toEqual([
      { kind: "text", label: "Dimension", text: "kind" },
      { kind: "text", label: "Funds", text: "100.00 %" },
    ]);
    const stored = (await db.select().from(schema.allocationTargets).all()).filter(
      (row) => row.userId === userId,
    );
    expect(stored).toEqual([]);
  });

  test("refuses a set that does not add up to 100 %, and a key the portfolio does not have", async () => {
    const { userId } = await seed();
    const short = await propose(userId, "propose_target_allocation", {
      dimension: "kind",
      targets: [{ key: "fund", weightPercent: "90" }],
    });
    expect(short.proposals).toEqual([]);
    expect(short.toolResult).toContain("must add up to 100 %");

    const unknown = await propose(userId, "propose_target_allocation", {
      dimension: "kind",
      targets: [{ key: "crypto", weightPercent: "100" }],
    });
    expect(unknown.proposals).toEqual([]);
    expect(unknown.toolResult).toContain("Unknown key: crypto");
  });
});

describe("propose_price_source", () => {
  test("describes the change and warns that a new currency drops stored prices, without touching the instrument", async () => {
    const { userId, instrumentId, isin } = await seed();
    const { proposals } = await propose(userId, "propose_price_source", {
      id: instrumentId,
      currency: "USD",
      priceSource: "page",
      sourceKey: "https://Example.com/acme",
    });

    expect(proposals[0]?.summary).toBe(
      `Change the price source of Acme Fund (${isin}) to a web page (https://example.com/acme), ` +
        "quoted in USD. The currency changes from EUR, so its stored prices are deleted. " +
        "The page is checked when you confirm.",
    );
    expect(proposals[0]?.facts).toEqual([
      { kind: "text", label: "Instrument", text: `Acme Fund (${isin})` },
      { kind: "text", label: "Source", text: "Web page" },
      { kind: "code", label: "Code", code: "https://example.com/acme" },
      { kind: "text", label: "Currency", text: "USD" },
      { kind: "text", label: "Stored prices", text: "Deleted: the currency changes from EUR" },
      { kind: "text", label: "Check", text: "The page is read when you confirm" },
    ]);
    const row = (await db.select().from(schema.instruments).all()).find(
      (instrument) => instrument.id === instrumentId,
    );
    expect(row?.priceSource).toBe("manual");
    expect(row?.currency).toBe("EUR");
  });

  test.each([
    ["page", "not a url", "public https"],
    ["page", "http://localhost/x", "public https"],
    ["yahoo", "acme.he", "ticker"],
    ["yahoo", "ACME HE", "ticker"],
    ["manual", "ACME", "manual source takes no code"],
  ])("refuses source %s with code %j", async (priceSource, sourceKey, message) => {
    const { userId, instrumentId } = await seed();
    const { proposals, toolResult } = await propose(userId, "propose_price_source", {
      id: instrumentId,
      currency: "EUR",
      priceSource,
      sourceKey,
    });

    expect(proposals).toEqual([]);
    expect(toolResult.toLowerCase()).toContain(message);
  });

  test("an instrument outside the caller's own ledger is refused", async () => {
    const { userId } = await seed();
    const other = await seed();
    const { proposals, toolResult } = await propose(userId, "propose_price_source", {
      id: other.instrumentId,
      currency: "EUR",
      priceSource: "yahoo",
      sourceKey: "ACME.HE",
    });

    expect(proposals).toEqual([]);
    expect(JSON.parse(toolResult)).toEqual({ error: "Instrument not found" });
  });
});

describe("propose_monthly_plan", () => {
  const second = async (name: string) =>
    (
      await addInstrument(db, {
        isin: randomIsin(),
        ticker: null,
        name,
        kind: "etf",
        currency: EUR,
        priceSource: "manual",
      })
    ).id;
  const planOf = async (userId: string) =>
    (await db.select().from(schema.monthlyPlan).all()).filter((row) => row.userId === userId);

  test("replace names the rows it removes and writes nothing before Confirm", async () => {
    const { userId, instrumentId, isin } = await seed();
    const old = await second("Old Fund");
    const { setPlanRow } = await import("../monthly-plan.ts");
    await setPlanRow(db, userId, { instrumentId: old, amountEur: "50" });
    const { proposals, toolResult } = await propose(userId, "propose_monthly_plan", {
      mode: "replace",
      rows: [{ instrumentId, amountEur: "150,5" }],
    });

    expect(proposals[0]?.action).toBe("monthly_plan");
    expect(proposals[0]?.title).toBe("Set the monthly plan");
    expect(proposals[0]?.facts).toEqual([
      { kind: "money", label: `Acme Fund (${isin})`, amount: "150.50", currency: "EUR" },
      { kind: "text", label: "Removed from the plan", text: expect.stringContaining("Old Fund") },
      { kind: "money", label: "Plan total per month", amount: "150.50", currency: "EUR" },
    ]);
    expect(JSON.parse(toolResult)).toMatchObject({ status: "awaiting_owner_confirmation" });
    expect((await planOf(userId)).map((row) => row.instrumentId)).toEqual([old]);
  });

  test("add keeps the other rows in the total and removes none", async () => {
    const { userId, instrumentId } = await seed();
    const old = await second("Old Fund");
    const { setPlanRow } = await import("../monthly-plan.ts");
    await setPlanRow(db, userId, { instrumentId: old, amountEur: "50" });
    const { proposals } = await propose(userId, "propose_monthly_plan", {
      mode: "add",
      rows: [{ instrumentId, amountEur: "100" }],
    });

    expect(proposals[0]?.title).toBe("Add to the monthly plan");
    expect(proposals[0]?.facts.some((fact) => fact.label === "Removed from the plan")).toBe(false);
    expect(proposals[0]?.facts.at(-1)).toMatchObject({ amount: "150.00" });
  });

  test("the card carries the exact removals and a fingerprint, and a later row makes Confirm refuse", async () => {
    const { userId, instrumentId } = await seed();
    const [old, later] = [await second("Old Fund"), await second("Later Fund")];
    const { setPlanRow, setPlanRows } = await import("../monthly-plan.ts");
    await setPlanRow(db, userId, { instrumentId: old, amountEur: "50" });
    const { proposals } = await propose(userId, "propose_monthly_plan", {
      mode: "replace",
      rows: [{ instrumentId, amountEur: "100" }],
    });
    const input = proposals[0]?.action === "monthly_plan" ? proposals[0].input : undefined;
    expect(input?.removeInstrumentIds).toEqual([old]);
    await setPlanRow(db, userId, { instrumentId: later, amountEur: "30" });
    await expect(setPlanRows(db, userId, input!)).rejects.toThrow("The plan changed");
    expect(new Set((await planOf(userId)).map((row) => row.instrumentId))).toEqual(
      new Set([old, later]),
    );
  });

  test("a duplicate instrument is refused", async () => {
    const { userId, instrumentId } = await seed();
    const { proposals } = await propose(userId, "propose_monthly_plan", {
      mode: "add",
      rows: [
        { instrumentId, amountEur: "10" },
        { instrumentId, amountEur: "20" },
      ],
    });
    expect(proposals).toEqual([]);
  });

  test("an unknown id is refused", async () => {
    const { userId } = await seed();
    const { proposals, toolResult } = await propose(userId, "propose_monthly_plan", {
      mode: "add",
      rows: [{ instrumentId: 999_999_999, amountEur: "10" }],
    });
    expect(proposals).toEqual([]);
    expect(toolResult).toContain("Instrument not found");
  });

  test.each(["0", "-5", "abc", "1000000.01"])("refuses amount %j", async (amountEur) => {
    const { userId, instrumentId } = await seed();
    const { proposals } = await propose(userId, "propose_monthly_plan", {
      mode: "add",
      rows: [{ instrumentId, amountEur }],
    });
    expect(proposals).toEqual([]);
  });
});

import { and, eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";

import { EUR } from "../../core/money.ts";
import { addCashEntry, removeCashEntry } from "../cash-entries.ts";
import { db } from "../db/index.ts";
import {
  chatMessages,
  conversations,
  forecastRates,
  imports,
  instrumentCosts,
  snapshots,
  transactions,
} from "../db/schema.ts";
import { setRateOverride, removeRateOverride } from "../forecast-rates.ts";
import { undo } from "../import/service.ts";
import { setOwnCharge } from "../instruments/costs.ts";
import { listPlan, removePlanRow, setPlanRow } from "../monthly-plan.ts";
import { createSnapshot, deleteSnapshot } from "../snapshot/service.ts";
import { addRules, removeRule, rulesFor } from "../spending/rules.ts";
import type { Proposal } from "./proposal-schema.ts";
import { bankAccount, onlyCard, propose, seed, spend } from "./proposal-test-kit.ts";

// Every removal: a warning card naming exactly the one thing, nothing removed before Confirm, and Confirm's own function removing only that.

const removal = (card: Proposal) => {
  expect(card.danger).toBe(true);
  return card;
};

describe("propose_delete_cash_entry", () => {
  const owner = async () => {
    const base = await seed();
    const bank = await bankAccount(base.userId, "OP Käyttötili");
    const entry = (input: { type: "DEPOSIT" | "WITHDRAWAL"; amount: string; tradeDate: string }) =>
      addCashEntry(base.userId, { accountId: bank, currency: EUR, ...input });
    const kept = await entry({ type: "DEPOSIT", amount: "500", tradeDate: "2026-11-03" });
    const target = await entry({ type: "WITHDRAWAL", amount: "75.5", tradeDate: "2026-11-04" });
    return { ...base, bank, kept: kept.id, target: target.id };
  };

  test("names the entry with its direction, amount, date and account; Delete removes only it", async () => {
    const { userId, bank, kept, target } = await owner();
    const card = removal(
      onlyCard(await propose(userId, "propose_delete_cash_entry", { id: target })),
    );

    expect(card.title).toBe("Delete a cash entry");
    expect(card.facts).toEqual([
      { kind: "text", label: "Cash entry", text: `Withdrawal (money out), entry #${target}` },
      { kind: "money", label: "Amount", amount: "75.50", currency: "EUR" },
      { kind: "text", label: "Date", text: "2026-11-04" },
      { kind: "text", label: "Account", text: `OP Käyttötili (account #${bank})` },
    ]);
    expect(card.input).toEqual({ id: target });
    const ids = async () =>
      (await db.select().from(transactions).where(eq(transactions.accountId, bank)).all()).map(
        (row) => row.id,
      );
    expect(await ids()).toEqual([kept, target]);

    if (card.action !== "delete_cash_entry") throw new Error("wrong card");
    await removeCashEntry(userId, card.input.id);
    expect(await ids()).toEqual([kept]);
  });

  test("an imported row and someone else's entry are refused", async () => {
    const { userId, accountId } = await owner();
    const other = await owner();
    const foreign = await propose(userId, "propose_delete_cash_entry", { id: other.target });
    expect(JSON.parse(foreign.toolResult)).toEqual({ error: "Cash entry not found" });
    const buyRow = await db
      .select()
      .from(transactions)
      .where(eq(transactions.accountId, accountId))
      .get();
    const imported = await propose(userId, "propose_delete_cash_entry", { id: buyRow?.id ?? 0 });
    expect(imported.toolResult).toContain("Only a cash entry typed by hand");
    expect([...foreign.proposals, ...imported.proposals]).toEqual([]);
  });
});

describe("propose_delete_plan_row", () => {
  test("names the row, its amount and the plan total after; Delete removes only it", async () => {
    const { userId, instrumentId, isin } = await seed();
    const second = await seed();
    await setPlanRow(db, userId, { instrumentId, amountEur: "100" });
    await setPlanRow(db, userId, { instrumentId: second.instrumentId, amountEur: "50" });

    const card = removal(
      onlyCard(await propose(userId, "propose_delete_plan_row", { instrumentId })),
    );
    expect(card.facts).toEqual([
      { kind: "text", label: "Plan row", text: `Acme Fund (${isin})` },
      { kind: "money", label: "Monthly amount", amount: "100.00", currency: "EUR" },
      { kind: "money", label: "Plan total afterwards", amount: "50.00", currency: "EUR" },
    ]);
    expect((await listPlan(db, userId)).rows).toHaveLength(2);

    if (card.action !== "delete_plan_row") throw new Error("wrong card");
    await removePlanRow(db, userId, card.input.instrumentId);
    expect((await listPlan(db, userId)).rows.map((row) => row.instrumentId)).toEqual([
      second.instrumentId,
    ]);
  });

  test("an instrument not in the plan is refused", async () => {
    const { userId, instrumentId } = await seed();
    const result = await propose(userId, "propose_delete_plan_row", { instrumentId });
    expect(result.proposals).toEqual([]);
    expect(result.toolResult).toContain("not in the monthly plan");
  });
});

describe("propose_delete_spending_rule", () => {
  test("names the rule, its category and whose it is; Delete removes only it", async () => {
    const { userId } = await seed();
    const bank = await bankAccount(userId);
    await spend(bank, "PKORTTIMAKSU — OUTOKAUPPA OY", -2_500, "2026-07-01");
    await addRules(db, userId, [{ pattern: "OUTOKAUPPA", category: "groceries" }], "user");
    const before = (await rulesFor(db, userId)).length;

    const card = removal(
      onlyCard(await propose(userId, "propose_delete_spending_rule", { pattern: "outokauppa" })),
    );
    expect(card.facts).toEqual([
      { kind: "code", label: "Rule", code: "OUTOKAUPPA" },
      { kind: "text", label: "Category", text: "Groceries" },
      { kind: "text", label: "Made by", text: "You" },
      { kind: "text", label: "Payments it matches", text: "1" },
    ]);
    expect(card.input).toEqual({ pattern: "OUTOKAUPPA" });
    expect(await rulesFor(db, userId)).toHaveLength(before);

    if (card.action !== "delete_spending_rule") throw new Error("wrong card");
    await removeRule(db, userId, card.input.pattern);
    const after = (await rulesFor(db, userId)).map((rule) => rule.pattern);
    expect(after).toHaveLength(before - 1);
    expect(after).not.toContain("OUTOKAUPPA");
  });

  test("a rule that is not there is refused", async () => {
    const { userId } = await seed();
    const result = await propose(userId, "propose_delete_spending_rule", { pattern: "NO SUCH" });
    expect(result.proposals).toEqual([]);
    expect(result.toolResult).toContain("No such rule");
  });
});

describe("propose_remove_snapshot", () => {
  test("names the statement and its row count; Delete removes only it", async () => {
    const { userId, accountId, instrumentId } = await seed();
    const statement = (asOf: string) =>
      createSnapshot(userId, {
        accountId,
        asOf,
        source: "manual",
        rows: [{ instrumentId, quantity: "1" }],
      });
    const kept = await statement("2026-09-30");
    const target = await statement("2026-10-31");

    const card = removal(
      onlyCard(await propose(userId, "propose_remove_snapshot", { snapshotId: target.id })),
    );
    expect(card.facts).toEqual([
      {
        kind: "text",
        label: "Holdings statement",
        text: `Nordnet (account #${accountId}), as of 2026-10-31 (#${target.id})`,
      },
      { kind: "text", label: "Source", text: "Typed by hand" },
      { kind: "text", label: "Rows removed", text: "1" },
      { kind: "text", label: "Kept", text: "Adjustments booked from it stay in the ledger" },
    ]);
    const ids = async () =>
      (await db.select().from(snapshots).where(eq(snapshots.accountId, accountId)).all()).map(
        (row) => row.id,
      );
    expect(await ids()).toEqual([kept.id, target.id]);

    if (card.action !== "remove_snapshot") throw new Error("wrong card");
    await deleteSnapshot(userId, card.input.snapshotId);
    expect(await ids()).toEqual([kept.id]);
  });

  test("someone else's statement is refused", async () => {
    const { userId } = await seed();
    const other = await seed();
    const theirs = await createSnapshot(other.userId, {
      accountId: other.accountId,
      asOf: "2026-10-31",
      source: "manual",
      rows: [{ instrumentId: other.instrumentId, quantity: "1" }],
    });
    const result = await propose(userId, "propose_remove_snapshot", { snapshotId: theirs.id });
    expect(result.proposals).toEqual([]);
    expect(JSON.parse(result.toolResult)).toEqual({ error: "Snapshot not found" });
  });
});

describe("propose_undo_import", () => {
  const imported = async (userId: string, accountId: number, filename: string, rows: number) => {
    const record = await db
      .insert(imports)
      .values({
        userId,
        kind: "csv_bank",
        filename,
        sha256: crypto.randomUUID(),
        status: "committed",
      })
      .returning()
      .get();
    if (record === undefined) throw new Error("no import");
    for (let index = 0; index < rows; index++) {
      await db
        .insert(transactions)
        .values({
          accountId,
          instrumentId: null,
          type: "WITHDRAWAL",
          tradeDate: "2026-10-0" + String(index + 1),
          quantity: 0,
          unitPrice: null,
          amount: -100,
          fee: 0,
          tax: 0,
          currency: EUR,
          fxRateEur: 100_000_000,
          contentHash: crypto.randomUUID(),
          importId: record.id,
        })
        .run();
    }
    return record;
  };

  test("names the file, its date and counts the rows it removes; Undo removes only that import's rows", async () => {
    const { userId } = await seed();
    const bank = await bankAccount(userId, "OP Käyttötili");
    const kept = await imported(userId, bank, "op-2026-09.csv", 2);
    const target = await imported(userId, bank, "op-2026-10.csv", 3);

    const card = removal(
      onlyCard(await propose(userId, "propose_undo_import", { importId: target.id })),
    );
    expect(card.title).toBe("Undo an import");
    expect(card.facts).toEqual([
      { kind: "text", label: "Import", text: `op-2026-10.csv (#${target.id})` },
      { kind: "text", label: "Imported on", text: target.createdAt.toISOString().slice(0, 10) },
      { kind: "text", label: "Account", text: `OP Käyttötili (account #${bank})` },
      { kind: "text", label: "Transactions removed", text: "3" },
    ]);
    const count = async (importId: number) =>
      (await db.select().from(transactions).where(eq(transactions.importId, importId)).all())
        .length;
    expect(await count(target.id)).toBe(3);

    if (card.action !== "undo_import") throw new Error("wrong card");
    await undo(userId, card.input.importId);
    expect(await count(target.id)).toBe(0);
    expect(await count(kept.id)).toBe(2);
  });

  test("an account number in the file name never reaches the model; a foreign or undone import is refused", async () => {
    const { userId } = await seed();
    const other = await seed();
    const bank = await bankAccount(userId);
    const named = await imported(userId, bank, "tiliote FI21 1234 5600 0007 85.csv", 1);
    const result = await propose(userId, "propose_undo_import", { importId: named.id });
    expect(result.toolResult).not.toContain("1234 5600");
    expect(result.toolResult).toContain("tiliote");

    const theirs = await imported(other.userId, await bankAccount(other.userId), "x.csv", 1);
    const foreign = await propose(userId, "propose_undo_import", { importId: theirs.id });
    expect(JSON.parse(foreign.toolResult)).toEqual({ error: "Import not found" });
    await undo(userId, named.id);
    const again = await propose(userId, "propose_undo_import", { importId: named.id });
    expect(again.toolResult).toContain("already undone");
    expect([...foreign.proposals, ...again.proposals]).toEqual([]);
  });
});

describe("propose_remove_conversation", () => {
  const conversation = async (userId: string, title: string) => {
    const row = await db.insert(conversations).values({ userId, title }).returning().get();
    if (row === undefined) throw new Error("no conversation");
    await db
      .insert(chatMessages)
      .values({ conversationId: row.id, role: "user", content: title })
      .run();
    return row;
  };

  test("names the conversation and its message count; Delete removes only it", async () => {
    const { userId } = await seed();
    const kept = await conversation(userId, "Tax 2025");
    const target = await conversation(userId, "Old question");

    const card = removal(
      onlyCard(await propose(userId, "propose_remove_conversation", { id: target.id })),
    );
    expect(card.facts).toEqual([
      { kind: "text", label: "Conversation", text: `Old question (#${target.id})` },
      { kind: "text", label: "Started", text: target.createdAt.toISOString().slice(0, 10) },
      { kind: "text", label: "Messages removed", text: "1" },
    ]);

    if (card.action !== "remove_conversation") throw new Error("wrong card");
    const { deleteConversation } = await import("./conversations.ts");
    await deleteConversation(userId, card.input.id);
    const left = (
      await db.select().from(conversations).where(eq(conversations.userId, userId)).all()
    ).map((row) => row.id);
    expect(left).toEqual([kept.id]);
  });

  test("the conversation in use and someone else's are refused", async () => {
    const { userId } = await seed();
    const other = await seed();
    const current = await conversation(userId, "This one");
    const theirs = await conversation(other.userId, "Theirs");

    const self = await propose(
      userId,
      "propose_remove_conversation",
      { id: current.id },
      "",
      current.id,
    );
    expect(self.toolResult).toContain("conversation you are in");
    const foreign = await propose(userId, "propose_remove_conversation", { id: theirs.id });
    expect(JSON.parse(foreign.toolResult)).toEqual({ error: "Conversation not found" });
    expect([...self.proposals, ...foreign.proposals]).toEqual([]);
  });
});

describe("propose_clear_fund_fee and propose_clear_forecast_rate", () => {
  test("a fee card names the fee it clears; clearing removes only that fund's fee", async () => {
    const { userId, instrumentId, isin } = await seed();
    const second = await seed();
    await setOwnCharge(db, instrumentId, 20, Date.now());
    await setOwnCharge(db, second.instrumentId, 30, Date.now());

    const card = removal(
      onlyCard(await propose(userId, "propose_clear_fund_fee", { id: instrumentId })),
    );
    expect(card.facts).toEqual([
      { kind: "text", label: "Fund", text: `Acme Fund (${isin})` },
      { kind: "text", label: "Fee cleared", text: "0.20 % a year (yours)" },
      { kind: "text", label: "Afterwards", text: "A fee lookup may fill it in again" },
    ]);
    expect(card.input).toEqual({ id: instrumentId, percent: "" });
    if (card.action !== "clear_fund_fee") throw new Error("wrong card");
    await setOwnCharge(db, card.input.id, null, Date.now());
    const left = await db.select().from(instrumentCosts).all();
    expect(left.some((row) => row.instrumentId === instrumentId)).toBe(false);
    expect(left.some((row) => row.instrumentId === second.instrumentId)).toBe(true);
  });

  test("a rate card names the rate it clears; clearing removes only that one", async () => {
    const { userId, instrumentId, isin } = await seed();
    const second = await seed();
    await setRateOverride(db, userId, { instrumentId, ratePercent: "7" });
    await setRateOverride(db, userId, { instrumentId: second.instrumentId, ratePercent: "4" });

    const card = removal(
      onlyCard(await propose(userId, "propose_clear_forecast_rate", { instrumentId })),
    );
    expect(card.facts).toEqual([
      { kind: "text", label: "Instrument", text: `Acme Fund (${isin})` },
      { kind: "text", label: "Rate cleared", text: "7.00 % a year (yours)" },
      {
        kind: "text",
        label: "Afterwards",
        text: "Forecasts use the rate measured from past prices",
      },
    ]);
    if (card.action !== "clear_forecast_rate") throw new Error("wrong card");
    await removeRateOverride(db, userId, card.input.instrumentId);
    const left = await db
      .select()
      .from(forecastRates)
      .where(and(eq(forecastRates.userId, userId)))
      .all();
    expect(left.map((row) => row.instrumentId)).toEqual([second.instrumentId]);
  });

  test("nothing to clear is refused", async () => {
    const { userId, instrumentId } = await seed();
    const fee = await propose(userId, "propose_clear_fund_fee", { id: instrumentId });
    expect(fee.toolResult).toContain("No fee is recorded");
    const rate = await propose(userId, "propose_clear_forecast_rate", { instrumentId });
    expect(rate.toolResult).toContain("No rate of the owner's");
    expect([...fee.proposals, ...rate.proposals]).toEqual([]);
  });
});

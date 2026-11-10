import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";

import { listAccounts } from "../accounts.ts";
import { db } from "../db/index.ts";
import { accounts, transactions } from "../db/schema.ts";
import { setAccountBalance } from "../import/bank-service.ts";
import { bankAccount, onlyCard, propose, seed, signUp, spend } from "./proposal-test-kit.ts";

// Account cards name every field the form would save; a balance card names the opening balance it implies.

describe("propose_create_account", () => {
  test("names every field, defaults included, and opens nothing", async () => {
    const userId = await signUp();
    const card = onlyCard(
      await propose(userId, "propose_create_account", {
        name: "OP määräaikaistili",
        broker: "op",
        kind: "bank",
        accountType: "fixed_term",
        maturityDate: "2027-06-30",
        interestRate: "3,25",
      }),
    );

    expect(card.action).toBe("create_account");
    expect(card.facts).toEqual([
      { kind: "text", label: "Name (as it will be saved)", text: "OP määräaikaistili" },
      { kind: "text", label: "Bank or broker", text: "OP" },
      { kind: "text", label: "Kind", text: "Bank account" },
      { kind: "text", label: "Type", text: "Fixed-term account" },
      { kind: "text", label: "Base currency", text: "EUR" },
      { kind: "text", label: "Maturity date", text: "2027-06-30" },
      { kind: "text", label: "Interest rate", text: "3.25 % a year" },
    ]);
    expect(card.input).toMatchObject({ kind: "bank", baseCurrency: "EUR", interestRate: "3,25" });
    expect(await listAccounts(db, userId)).toEqual([]);
  });

  test("a type of the other kind and a maturity date off a fixed-term account are refused", async () => {
    const userId = await signUp();
    const mixed = await propose(userId, "propose_create_account", {
      name: "X",
      broker: "nordnet",
      kind: "brokerage",
      accountType: "savings",
    });
    expect(mixed.toolResult).toContain("does not fit kind brokerage");
    const terms = await propose(userId, "propose_create_account", {
      name: "X",
      broker: "op",
      kind: "bank",
      accountType: "current",
      maturityDate: "2027-01-01",
    });
    expect(terms.toolResult).toContain("only to fixed-term accounts");
    expect([...mixed.proposals, ...terms.proposals]).toEqual([]);
  });
});

describe("propose_edit_account", () => {
  test("shows each changed field as old and new, and changes nothing yet", async () => {
    const { userId, accountId } = await seed();
    const card = onlyCard(
      await propose(userId, "propose_edit_account", {
        id: accountId,
        changes: { name: "Nordnet OST", accountType: "ost" },
      }),
    );

    expect(card.facts).toEqual([
      { kind: "text", label: "Account", text: `Nordnet (account #${accountId})` },
      { kind: "text", label: "Name", text: "Nordnet → Nordnet OST" },
      { kind: "text", label: "Type", text: "Not set → Equity savings account (OST)" },
    ]);
    expect(card.input).toEqual({
      id: accountId,
      changes: { name: "Nordnet OST", accountType: "ost" },
    });
    const stored = await db.select().from(accounts).where(eq(accounts.id, accountId)).get();
    expect(stored?.name).toBe("Nordnet");
  });

  test("someone else's account is refused, and so is an empty change", async () => {
    const { userId } = await seed();
    const other = await seed();
    const foreign = await propose(userId, "propose_edit_account", {
      id: other.accountId,
      changes: { name: "Mine now" },
    });
    expect(foreign.toolResult).toContain("Account not found");
    const empty = await propose(userId, "propose_edit_account", {
      id: other.accountId,
      changes: {},
    });
    expect(empty.toolResult).toContain("No fields to change");
    expect([...foreign.proposals, ...empty.proposals]).toEqual([]);
  });
});

describe("propose_account_balance", () => {
  const owner = async () => {
    const userId = await signUp();
    const accountId = await bankAccount(userId);
    await spend(accountId, "PKORTTIMAKSU — KAUPPA", -2_000, "2026-03-01");
    return { userId, accountId };
  };

  test("names the balance and the opening balance it implies, and writes nothing", async () => {
    const { userId, accountId } = await owner();
    const card = onlyCard(
      await propose(userId, "propose_account_balance", {
        accountId,
        on: "2026-06-01",
        balance: "-80",
      }),
    );

    expect(card.facts).toEqual([
      { kind: "text", label: "Account", text: `OP current account (account #${accountId})` },
      { kind: "money", label: "Balance on 2026-06-01", amount: "-80.00", currency: "EUR" },
      { kind: "money", label: "Opening balance written", amount: "-60.00", currency: "EUR" },
      { kind: "text", label: "Opening balance date", text: "2026-02-28" },
      { kind: "text", label: "Replaces", text: "No opening balance recorded" },
    ]);
    expect(card.input).toEqual({
      accountId,
      on: "2026-06-01",
      balance: "-80",
      expectOpeningEur: "-60.00",
      expectOpeningDate: "2026-02-28",
    });
    const rows = await db
      .select()
      .from(transactions)
      .where(eq(transactions.accountId, accountId))
      .all();
    expect(rows.map((row) => row.type)).toEqual(["WITHDRAWAL"]);
  });

  test("a ledger changed after the card was made is refused on Confirm, not written unseen", async () => {
    const { userId, accountId } = await owner();
    const card = onlyCard(
      await propose(userId, "propose_account_balance", {
        accountId,
        on: "2026-06-01",
        balance: "100",
      }),
    );
    if (card.action !== "account_balance") throw new Error("wrong card");
    await spend(accountId, "PKORTTIMAKSU — TOINEN", -500, "2026-04-01");

    await expect(setAccountBalance(userId, card.input)).rejects.toThrow("changed since the card");
  });

  test("someone else's account is refused", async () => {
    const { userId } = await owner();
    const other = await owner();
    const result = await propose(userId, "propose_account_balance", {
      accountId: other.accountId,
      on: "2026-06-01",
      balance: "100",
    });

    expect(result.proposals).toEqual([]);
    expect(result.toolResult).toContain("Account not found");
  });
});

describe("account numbers in names", () => {
  test("the owner's card keeps the real name; what the model reads has the number masked", async () => {
    const userId = await signUp();
    const accountId = await bankAccount(userId, "OP 1234567-8");
    const result = await propose(userId, "propose_account_balance", {
      accountId,
      on: "2026-06-01",
      balance: "100",
    });

    expect(JSON.stringify(onlyCard(result).facts)).toContain("OP 1234567-8");
    expect(result.toolResult).not.toContain("1234567");
    expect(result.toolResult).toContain(`OP … (account #${accountId})`);
  });
});

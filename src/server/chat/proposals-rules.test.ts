import { describe, expect, test } from "vitest";

import { db } from "../db/index.ts";
import { addRules, rulesFor } from "../spending/rules.ts";
import { bankAccount, onlyCard, propose, signUp, spend } from "./proposal-test-kit.ts";

// Rules are cards now: nothing is classified until the owner confirms, and only payees the ledger holds.

const owner = async () => {
  const userId = await signUp();
  const accountId = await bankAccount(userId);
  await spend(accountId, "PKORTTIMAKSU — OUTOKAUPPA OY", -2_500, "2026-07-01");
  await spend(accountId, "PKORTTIMAKSU — OUTOKAUPPA OY", -1_200, "2026-07-08");
  return { userId, accountId };
};

const patterns = async (userId: string) => (await rulesFor(db, userId)).map((rule) => rule.pattern);

describe("propose_spending_rules", () => {
  test("names each rule, its category and what it catches, and saves nothing", async () => {
    const { userId } = await owner();
    const card = onlyCard(
      await propose(userId, "propose_spending_rules", {
        rules: [{ pattern: "outokauppa", category: "groceries" }],
      }),
    );

    expect(card.action).toBe("spending_rules");
    expect(card.facts).toEqual([
      { kind: "code", label: "Payee text", code: "OUTOKAUPPA" },
      { kind: "text", label: "Category", text: "Groceries" },
      { kind: "text", label: "Catches", text: "2 uncategorised transactions" },
      { kind: "text", label: "Saved as", text: "Your own rules, editable on the Spending page" },
    ]);
    expect(card.input).toEqual({ rules: [{ pattern: "OUTOKAUPPA", category: "groceries" }] });
    expect(await patterns(userId)).not.toContain("OUTOKAUPPA");
  });

  test("a payee the ledger does not hold, an unknown category and an existing rule are refused", async () => {
    const { userId } = await owner();
    await addRules(db, userId, [{ pattern: "OUTOKAUPPA OY", category: "groceries" }], "user");

    const invented = await propose(userId, "propose_spending_rules", {
      rules: [{ pattern: "KEKSITTY KAUPPA", category: "groceries" }],
    });
    expect(invented.toolResult).toContain("KEKSITTY KAUPPA");
    const category = await propose(userId, "propose_spending_rules", {
      rules: [{ pattern: "OUTOKAUPPA", category: "kryptovaluutta" }],
    });
    expect(category.toolResult).toContain("Unknown category");
    const twice = await propose(userId, "propose_spending_rules", {
      rules: [{ pattern: "OUTOKAUPPA OY", category: "groceries" }],
    });
    expect(twice.toolResult).toContain("already has a rule");
    expect([...invented.proposals, ...category.proposals, ...twice.proposals]).toEqual([]);
  });
});

describe("propose_spending_rule_category", () => {
  test("shows the rule with its old and new category, even one the owner wrote", async () => {
    const { userId } = await owner();
    await addRules(db, userId, [{ pattern: "OUTOKAUPPA", category: "groceries" }], "user");

    const card = onlyCard(
      await propose(userId, "propose_spending_rule_category", {
        pattern: "outokauppa",
        category: "restaurants",
      }),
    );

    expect(card.facts).toEqual([
      { kind: "code", label: "Rule", code: "OUTOKAUPPA" },
      { kind: "text", label: "From", text: "Groceries" },
      { kind: "text", label: "To", text: "Restaurants and cafes" },
    ]);
    expect(card.input).toEqual({ pattern: "OUTOKAUPPA", category: "restaurants" });
    const rule = (await rulesFor(db, userId)).find((row) => row.pattern === "OUTOKAUPPA");
    expect(rule?.category).toBe("groceries");
  });

  test("a rule that is not there is refused rather than invented", async () => {
    const { userId } = await owner();
    const result = await propose(userId, "propose_spending_rule_category", {
      pattern: "NO SUCH RULE",
      category: "leisure",
    });

    expect(result.proposals).toEqual([]);
    expect(result.toolResult).toContain("No such rule");
  });
});

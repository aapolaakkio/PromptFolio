import type { Page } from "@playwright/test";

import { expect, test } from "./harness/test.ts";
import { createBankAccount, importOpCsv, opCsv, opRow } from "./harness/flows.ts";

/** The page draws a cash-flow diagram that needs income; every period used below holds some. */
const salary = (id: string): string =>
  opRow("2025-09-01", "1000,00", "PALKKA", "ESIMERKKI OYJ", id);

/** Fixed dates, never today's: the page's default range is the last year. */
const showPeriod = async (page: Page, from: string, to: string): Promise<void> => {
  await page.getByLabel("From").fill(from);
  await page.getByLabel("To").fill(to);
};

const categoryTable = (page: Page) =>
  page.getByRole("table").filter({ has: page.getByRole("columnheader", { name: "Category" }) });

const importFixture = async (page: Page, claude: Parameters<typeof importOpCsv>[1]) => {
  await createBankAccount(page, "OP Current");
  await importOpCsv(page, claude, { account: "OP Current" });
  await page.goto("/spending");
};

test("spending totals by category for the fixture's period", async ({
  page,
  user: _user,
  claude,
}) => {
  await importFixture(page, claude);
  await showPeriod(page, "2025-01-01", "2026-12-31");

  const table = categoryTable(page).first();
  await expect(table.getByRole("row", { name: /^Groceries 1 / })).toContainText("-€42.15");
  await expect(table.getByRole("row", { name: /^Insurance 1 / })).toContainText("-€59.90");
  await expect(page.getByText("Spending: €102.05")).toBeVisible();
  await expect(page.getByText("Salary and benefits: €2,750.00")).toBeVisible();
});

test("a payee without a category gets a rule and moves out of Other", async ({
  page,
  user: _user,
  claude,
}) => {
  await createBankAccount(page, "OP Current");
  const file = opCsv(
    salary("2025090100000009"),
    opRow("2025-09-02", "-23,50", "PKORTTIMAKSU", "ZZ TESTIKAUPPA", "2025090200000001"),
  );
  // The classifier knows no rule for the payee, so it stays uncategorised.
  await importOpCsv(page, claude, { account: "OP Current", file, classifier: { rules: [] } });
  await page.goto("/spending");
  await showPeriod(page, "2025-09-01", "2025-09-30");

  await expect(page.getByRole("row", { name: /^Other 1 / })).toContainText("-€23.50");
  await page
    .getByRole("combobox", { name: "Categorise ZZ TESTIKAUPPA" })
    .selectOption({ label: "Leisure" });

  await expect(page.getByText("Every payment in the period is categorised.")).toBeVisible();
  await expect(page.getByRole("row", { name: /^Leisure 1 / })).toContainText("-€23.50");
  await expect(page.getByRole("row", { name: /^Other / })).toHaveCount(0);

  await page.getByRole("button", { name: "Show categorisation rules" }).click();
  const rule = page.getByRole("row", { name: /^ZZ TESTIKAUPPA / });
  await expect(rule).toContainText("leisure");
  await expect(rule).toContainText("user");
});

test("switching the period changes the totals", async ({ page, user: _user, claude }) => {
  await importFixture(page, claude);

  await showPeriod(page, "2025-09-01", "2025-09-30");
  await expect(page.getByRole("row", { name: /^Groceries 1 / })).toBeVisible();
  await expect(page.getByRole("row", { name: /^Insurance / })).toHaveCount(0);

  await showPeriod(page, "2025-12-01", "2026-01-31");
  await expect(page.getByRole("row", { name: /^Insurance 1 / })).toBeVisible();
  await expect(page.getByRole("row", { name: /^Groceries / })).toHaveCount(0);

  await showPeriod(page, "2024-01-01", "2024-01-31");
  await expect(page.getByText("No spending in this period.")).toBeVisible();
});

test("a transfer between the user's own accounts is not spending", async ({
  page,
  user: _user,
  claude,
}) => {
  await createBankAccount(page, "OP Current");
  await createBankAccount(page, "OP Savings");
  const out = opCsv(
    salary("2025090100000008"),
    opRow("2025-09-10", "-250,00", "TILISIIRTO", "OMA SAASTOTILI", "2025091000000001"),
    opRow("2025-09-11", "-10,00", "PKORTTIMAKSU", "K-MARKET ESIMERKKI", "2025091100000002"),
  );
  const incoming = opCsv(
    opRow("2025-09-10", "250,00", "TILISIIRTO", "OMA PAIVATILI", "2025091000000003"),
  );
  await importOpCsv(page, claude, { account: "OP Current", file: out });
  await importOpCsv(page, claude, { account: "OP Savings", file: incoming, recipe: false });

  await page.goto("/spending");
  await showPeriod(page, "2025-09-01", "2025-09-30");
  await expect(page.getByRole("row", { name: /^Groceries 1 / })).toBeVisible();
  await expect(page.getByRole("row", { name: /^Account transfers / })).toHaveCount(0);
  await expect(page.getByText("Total -€10.00.")).toBeVisible();

  await page.getByRole("button", { name: "Show all transactions and categories" }).click();
  await expect(page.getByRole("row", { name: /OMA SAASTOTILI/ })).toContainText(
    "not spending: own transfer",
  );
  await expect(page.getByRole("row", { name: /OMA PAIVATILI/ })).toContainText(
    "not spending: own transfer",
  );
});

// App bug: a period with spending and no income crashes the page ("sankeyDiagram: source at link index 0 does not match a node key").
test.fixme("a period with spending but no income still renders", async ({
  page,
  user: _user,
  claude,
}) => {
  await importFixture(page, claude);
  await showPeriod(page, "2026-01-01", "2026-01-31");
  await expect(page.getByRole("row", { name: /^Insurance 1 / })).toBeVisible();
});

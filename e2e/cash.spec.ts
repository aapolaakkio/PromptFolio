import { expect, test } from "./harness/test.ts";
import { createBankAccount, importOpCsv } from "./harness/flows.ts";

test("a bank account is created from Cash and selected", async ({ page, user: _user }) => {
  await page.goto("/cash");
  await expect(page.getByRole("button", { name: "+ New bank account" })).toBeVisible();

  await createBankAccount(page, "OP Current");

  await expect(page.getByText("No bank accounts yet.")).toBeHidden();
  await expect(page.getByRole("heading", { name: "Reconcile balance" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Manual entries" })).toBeVisible();
});

test("the OP CSV imports 5 rows and Cash shows the balance they add up to", async ({
  page,
  user: _user,
  claude,
}) => {
  await createBankAccount(page, "OP Current");
  await importOpCsv(page, claude, { account: "OP Current" });
  await expect(page.getByText("5 new transactions, 0 already imported.")).toBeVisible();

  await page.goto("/cash");
  const row = page.getByRole("row", { name: /^OP Current EUR/ });
  await expect(row.getByRole("cell", { name: "1660.29", exact: true })).toBeVisible();
  await expect(row.getByRole("cell", { name: "€1,660.29" })).toBeVisible();
});

test("a manual deposit is added and removed", async ({ page, user: _user }) => {
  await createBankAccount(page, "Ferratum");
  const form = page.getByRole("heading", { name: "Manual entries" }).locator("..");
  await form.getByLabel("Date").fill("2025-03-15");
  await form.getByLabel("Amount").fill("100.00");
  await form.getByLabel("Note").fill("Birthday money");
  await form.getByRole("button", { name: "Record" }).click();

  const entry = page.getByRole("row", { name: /Birthday money/ });
  await expect(entry).toBeVisible();
  await expect(entry.getByRole("cell", { name: "100.00" })).toBeVisible();
  await expect(page.getByRole("row", { name: /^Ferratum EUR 100\.00/ })).toBeVisible();

  await page.getByRole("button", { name: "Delete entry 2025-03-15" }).click();

  await expect(entry).toHaveCount(0);
  await expect(page.getByText("No cash. Create a bank account")).toBeVisible();
});

test("renaming an account on Imports shows the new name and type on Cash", async ({
  page,
  user: _user,
}) => {
  await createBankAccount(page, "Old name");
  await page.goto("/imports");
  await page
    .getByRole("combobox", { name: "Account", exact: true })
    .selectOption({ label: "Old name" });
  await page.getByRole("button", { name: "Edit account" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Account name").fill("Renamed account");
  await dialog.getByRole("combobox", { name: "Account type" }).selectOption("savings");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();

  await page.goto("/cash");
  await expect(page.getByRole("combobox", { name: "Bank account" })).toContainText(
    "Renamed account · Savings account",
  );
  await expect(page.getByRole("combobox", { name: "Bank account" })).not.toContainText("Old name");
});

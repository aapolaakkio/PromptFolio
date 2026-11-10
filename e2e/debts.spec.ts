import { importNordnet } from "./harness/flows.ts";
import type { Page } from "@playwright/test";
import { expect, test } from "./harness/test.ts";

/** Fixed past dates: valid at any hour, whatever the day the suite runs. */
const FIRST = "2025-01-15";
const SECOND = "2025-03-01";
const BETWEEN = "2025-02-01";

/** The page's date format (en-GB, short) for an ISO date. */
const shown = (iso: string): string => iso.split("-").reverse().join("/");

const openDebts = async (page: Page): Promise<void> => {
  await page.goto("/debts");
  await expect(page.getByText("No debts yet.", { exact: false })).toBeVisible();
};

const addDebt = async (page: Page, name: string, kind: string, rate = ""): Promise<void> => {
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByLabel("Kind").selectOption({ label: kind });
  await page.getByLabel(/Interest rate/).fill(rate);
  await page.getByRole("button", { name: "Add debt" }).click();
  await expect(page.getByRole("heading", { name, level: 2 })).toBeVisible();
};

/** The card of one debt: the heading's own container. */
const card = (page: Page, name: string) =>
  page.getByRole("heading", { name, level: 2 }).locator("../../..");

const addBalance = async (page: Page, name: string, date: string, owed: string): Promise<void> => {
  const form = card(page, name);
  await form.getByLabel("Date").fill(date);
  await form.getByLabel("Owed (EUR)").fill(owed);
  await form.getByRole("button", { name: "Save balance" }).click();
  // The form clears its amount when the save lands: wait for the row before the next fill.
  await expect(
    form.getByRole("button", { name: `Remove the balance of ${shown(date)}` }),
  ).toBeVisible();
};

const total = (page: Page) => page.getByText("Owed in total").locator("..");

test("a student loan and a credit card are added with their kind and rate", async ({
  page,
  user: _user,
}) => {
  await openDebts(page);
  await expect(total(page)).toContainText("€0.00");

  await addDebt(page, "Student loan", "Student loan", "2,5");
  await addDebt(page, "Visa", "Credit card");

  await expect(card(page, "Student loan")).toContainText("Student loan · interest 2.50 %");
  await expect(card(page, "Student loan")).toContainText("No balance yet");
  await expect(card(page, "Visa")).toContainText("Credit card");
  await expect(card(page, "Visa")).not.toContainText("interest");
  await expect(page.getByText("No debts yet.", { exact: false })).toBeHidden();
});

test("Owed in total follows the latest balance of each debt", async ({ page, user: _user }) => {
  await openDebts(page);
  await addDebt(page, "Student loan", "Student loan");
  await addDebt(page, "Visa", "Credit card");

  await addBalance(page, "Student loan", FIRST, "1000");
  await expect(total(page)).toContainText("€1,000.00");

  await addBalance(page, "Student loan", SECOND, "800");
  await expect(total(page)).toContainText("€800.00");
  await expect(card(page, "Student loan")).toContainText("Owed, as of 01/03/2025");

  // A balance dated before the latest one does not change what is owed now.
  await addBalance(page, "Student loan", BETWEEN, "900");
  await expect(card(page, "Student loan").getByRole("row")).toHaveCount(4);
  await expect(total(page)).toContainText("€800.00");

  // The second debt adds to the total.
  await addBalance(page, "Visa", FIRST, "250,50");
  await expect(total(page)).toContainText("€1,050.50");
});

test("a balance dated in the future cannot be submitted from the form", async ({
  page,
  user: _user,
}) => {
  await openDebts(page);
  await addDebt(page, "Student loan", "Student loan");
  const loan = card(page, "Student loan");
  await loan.getByLabel("Date").fill("2099-01-01");
  await loan.getByLabel("Owed (EUR)").fill("500");

  await loan.getByRole("button", { name: "Save balance" }).click();

  // The browser's own max on the date field stops the submit: no request, no message from the app.
  expect(
    await loan.getByLabel("Date").evaluate((el: HTMLInputElement) => el.validity.rangeOverflow),
  ).toBe(true);
  await expect(loan).toContainText("No balance yet");
  await expect(total(page)).toContainText("€0.00");
});

test("the server refuses a balance dated in the future with its own message", async ({
  page,
  user: _user,
}) => {
  await openDebts(page);
  await addDebt(page, "Student loan", "Student loan");
  const loan = card(page, "Student loan");
  // The form's max is the client's guard; lifting it reaches the server's, which the form alone never does.
  await loan.getByLabel("Date").evaluate((el: HTMLInputElement) => el.removeAttribute("max"));
  await loan.getByLabel("Date").fill("2099-01-01");
  await loan.getByLabel("Owed (EUR)").fill("500");

  await loan.getByRole("button", { name: "Save balance" }).click();

  await expect(loan.getByRole("alert")).toHaveText("A balance cannot be dated in the future");
  await expect(loan).toContainText("No balance yet");
});

test("a balance is removed from its table", async ({ page, user: _user }) => {
  await openDebts(page);
  await addDebt(page, "Student loan", "Student loan");
  await addBalance(page, "Student loan", FIRST, "1000");
  await addBalance(page, "Student loan", SECOND, "800");
  await expect(total(page)).toContainText("€800.00");

  await page.getByRole("button", { name: "Remove the balance of 01/03/2025" }).click();

  await expect(total(page)).toContainText("€1,000.00");
  await expect(page.getByRole("button", { name: "Remove the balance of 01/03/2025" })).toBeHidden();
  await expect(card(page, "Student loan")).toContainText("Owed, as of 15/01/2025");
});

test("a debt is removed only after the confirm dialog, with its balances", async ({
  page,
  user: _user,
}) => {
  await openDebts(page);
  await addDebt(page, "Student loan", "Student loan");
  await addBalance(page, "Student loan", FIRST, "1000");
  await expect(total(page)).toContainText("€1,000.00");

  await card(page, "Student loan").getByRole("button", { name: "Remove debt" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Remove Student loan?" })).toBeVisible();
  await expect(dialog).toContainText("This also removes all of its balances. It cannot be undone.");

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("heading", { name: "Student loan", level: 2 })).toBeVisible();

  await card(page, "Student loan").getByRole("button", { name: "Remove debt" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();

  await expect(page.getByText("No debts yet.", { exact: false })).toBeVisible();
  await expect(total(page)).toContainText("€0.00");
});

test("the Dashboard shows Net worth and the before-debts chart title only with a debt", async ({
  page,
  user: _user,
  claude,
}) => {
  await importNordnet(page, claude);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Value over time", level: 2 })).toBeVisible();
  await expect(page.getByText("Net worth", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: /before debts/ })).toHaveCount(0);

  await page.goto("/debts");
  await addDebt(page, "Student loan", "Student loan");
  await addBalance(page, "Student loan", FIRST, "500");
  await expect(total(page)).toContainText("€500.00");

  await page.goto("/");
  await expect(page.getByText("Net worth", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("owned €1,875.09 − owed €500.00")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Value over time (before debts)", level: 2 }),
  ).toBeVisible();
});

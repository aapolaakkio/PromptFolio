import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

const OWNER = {
  name: "E2E Owner",
  email: "e2e@example.com",
  password: "correct horse battery staple",
};

const FIXTURE = resolve("src/server/import/fixtures/nordnet-sample.csv");

/** Empty instance to holdings through the pages. The fixture is read as bytes: it is UTF-16LE, and re-encoding breaks broker sniffing. */
test("first run: an owner signs up, opens an account, imports a Nordnet export and sees the holdings", async ({
  page,
}) => {
  await page.goto("/login");

  await page.getByLabel("Name", { exact: true }).fill(OWNER.name);
  await page.getByLabel("Email").fill(OWNER.email);
  await page.getByLabel("Password", { exact: true }).fill(OWNER.password);
  await page.getByLabel("Confirm password").fill(OWNER.password);
  await page.getByRole("button", { name: /create account/i }).click();

  await expect(page).toHaveURL("/");

  await page.goto("/imports");
  await expect(page.getByRole("heading", { name: "Imports" })).toBeVisible();

  // With no accounts yet the page shows the creation form on its own.
  await page.getByLabel("Account name").fill("Nordnet");
  await page.getByLabel("Broker").selectOption("nordnet");
  await page.getByRole("button", { name: "Create account" }).click();

  const account = page.getByLabel("AccountChoose an account");
  await expect(account).toHaveValue(/\d+/);

  await page.getByLabel(/Broker CSV or PDF files/).setInputFiles({
    name: "nordnet-sample.csv",
    mimeType: "text/csv",
    buffer: readFileSync(FIXTURE),
  });
  await page.getByRole("button", { name: "Preview" }).click();

  // 13 rows; the fractional adjustment's cash-only twin is reported, not booked.
  const commit = page.getByRole("button", { name: /^Import 12 transactions$/ });
  await expect(commit).toBeEnabled();
  await commit.click();

  // Every row is a duplicate: nothing is written twice.
  await page.getByLabel(/Broker CSV or PDF files/).setInputFiles({
    name: "nordnet-sample.csv",
    mimeType: "text/csv",
    buffer: readFileSync(FIXTURE),
  });
  await page.getByRole("button", { name: "Preview" }).click();
  await page.getByRole("button", { name: /^Import 12 transactions$/ }).click();
  await expect(page.getByText("0 transactions imported, 12 skipped as duplicates")).toBeVisible();

  await page.goto("/holdings");
  // One BUY of 2 units at 34.00 with no fee, never sold.
  const wisdomTree = page.getByRole("row", { name: /WisdomTree/ });
  await expect(wisdomTree).toContainText("€68.00");

  // Sells 5 units of a fund it never bought: quantity kept, no money figures.
  const unmatched = page.getByRole("row", { name: /Nordnet Suomi Indeksi/ });
  await expect(unmatched).toContainText("-5");
});

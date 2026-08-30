import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

const OWNER = {
  name: "E2E Omistaja",
  email: "e2e@example.com",
  password: "correct horse battery staple",
};

const FIXTURE = resolve("src/server/import/fixtures/nordnet-sample.csv");

/**
 * The whole app through the pages: an empty instance, its first owner, an
 * account, a real Nordnet export, and the holdings that come out of it. Read as
 * bytes rather than text -- the fixture is UTF-16LE, and re-encoding it would
 * destroy what the broker sniffing has to read.
 */
test("first run: an owner signs up, opens an account, imports a Nordnet export and sees the holdings", async ({
  page,
}) => {
  await page.goto("/login");

  await page.getByLabel("Nimi").fill(OWNER.name);
  await page.getByLabel("Sähköposti").fill(OWNER.email);
  await page.getByLabel("Salasana", { exact: true }).fill(OWNER.password);
  await page.getByLabel("Vahvista salasana").fill(OWNER.password);
  await page.getByRole("button", { name: /luo tili/i }).click();

  await expect(page).toHaveURL("/");

  await page.goto("/imports");
  await expect(page.getByRole("heading", { name: "Tuonnit" })).toBeVisible();

  // With no accounts yet the page shows the creation form on its own.
  await page.getByLabel("Tilin nimi").fill("Nordnet");
  await page.getByLabel("Välittäjä").selectOption("nordnet");
  await page.getByRole("button", { name: "Luo tili" }).click();

  const account = page.getByLabel("TiliValitse tili");
  await expect(account).toHaveValue(/\d+/);

  await page.getByLabel(/CSV-tiedosto \(Nordnet\)/).setInputFiles({
    name: "nordnet-sample.csv",
    mimeType: "text/csv",
    buffer: readFileSync(FIXTURE),
  });
  await page.getByRole("button", { name: "Esikatsele" }).click();

  // 13 rows in the fixture; the fractional adjustment's cash-only twin is
  // reported rather than booked, so 12 reach the draft.
  const commit = page.getByRole("button", { name: /^Tuo 12 tapahtumaa$/ });
  await expect(commit).toBeEnabled();
  await commit.click();

  // The same file again: every row is a duplicate, so nothing is written a
  // second time and the holdings below are unaffected by importing twice.
  await page.getByLabel(/CSV-tiedosto \(Nordnet\)/).setInputFiles({
    name: "nordnet-sample.csv",
    mimeType: "text/csv",
    buffer: readFileSync(FIXTURE),
  });
  await page.getByRole("button", { name: "Esikatsele" }).click();
  await page.getByRole("button", { name: /^Tuo 12 tapahtumaa$/ }).click();
  await expect(page.getByText("0 tapahtumaa tuotu, 12 ohitettu kaksoiskappaleena")).toBeVisible();

  await page.goto("/holdings");
  // One BUY of 2 units at 34,00 with no fee, never sold.
  const wisdomTree = page.getByRole("row", { name: /WisdomTree/ });
  await expect(wisdomTree).toContainText("68,00");

  // The fixture sells 5 units of a fund it never bought. The row stays, with
  // the quantity as the honest ledger fact and no money figures at all.
  const unmatched = page.getByRole("row", { name: /Nordnet Suomi Indeksi/ });
  await expect(unmatched).toContainText("-5");
});

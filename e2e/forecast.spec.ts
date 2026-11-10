import type { Page } from "@playwright/test";

import { importNordnet } from "./harness/flows.ts";
import { expect, test } from "./harness/test.ts";

const SEEDED_WISDOMTREE = "WisdomTree Europe Defence UCITS ETF - EUR Acc (IE0002Y8CX98)";

/** Instrument names are not unique in a worker's database (other specs add copies under a new ISIN); the option label carries the ISIN. */
const addToPlan = async (page: Page, amount: string): Promise<void> => {
  await page.getByLabel("Instrument to add").selectOption({ label: SEEDED_WISDOMTREE });
  await page.getByLabel("Amount per month in euros").fill(amount);
  await page.getByRole("button", { name: "Add", exact: true }).click();
};

test("a plan row is added, changed and removed, and the total follows", async ({
  page,
  user: _user,
}) => {
  await page.goto("/forecast");
  await expect(page.getByText("No monthly plan yet.")).toBeVisible();

  await addToPlan(page, "50");
  const amount = page.getByLabel(
    "WisdomTree Europe Defence UCITS ETF - EUR Acc per month in euros",
  );
  await expect(amount).toHaveValue("50.00");
  await expect(page.getByRole("cell", { name: "IE0002Y8CX98" })).toBeVisible();
  await expect(page.getByText("€50.00 per month")).toBeVisible();
  await expect(page.getByText("No monthly plan yet.")).toHaveCount(0);

  await amount.fill("75.50");
  await amount.press("Enter");
  await expect(page.getByText("€75.50 per month")).toBeVisible();
  await expect(amount).toHaveValue("75.50");

  await page.reload();
  await expect(page.getByText("€75.50 per month")).toBeVisible();

  await page
    .getByRole("button", {
      name: "Remove WisdomTree Europe Defence UCITS ETF - EUR Acc from the plan",
    })
    .click();
  await expect(page.getByText("No monthly plan yet.")).toBeVisible();
  await expect(page.getByText("per month", { exact: false })).toHaveCount(0);
});

const WISDOMTREE_ROW = /^WisdomTree Europe Defence/;

test("the horizon buttons redraw the forecast from 1 to 20 years", async ({
  page,
  user: _user,
  claude,
}) => {
  await importNordnet(page, claude);
  await page.goto("/forecast");
  // The only holding with a value is the WisdomTree buy at its cost of 68.00; no price history, so the default 6 % a year applies.
  // Today's euros take off the 2 % inflation: 68 x (1.06 / 1.02) ^ years.
  const row = page.getByRole("row", { name: WISDOMTREE_ROW });
  await expect(row).toContainText("€68.00");
  await expect(row.getByLabel(/expected yearly growth in percent/)).toHaveValue("6.00");
  await expect(row).toContainText("default, too little history");

  const expected = [
    ["1 year", "€70.67"],
    ["5 years", "€82.42"],
    ["10 years", "€99.90"],
    ["20 years", "€146.77"],
  ] as const;
  for (const [horizon, value] of expected) {
    await page.getByRole("button", { name: horizon, exact: true }).click();
    const years = horizon.split(" ")[0];
    await expect(page.getByRole("button", { name: horizon, exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByText(`In ${horizon}: ${value}`)).toBeVisible();
    await expect(page.getByRole("columnheader", { name: `In ${years} y, expected` })).toBeVisible();
    await expect(row).toContainText(value);
  }
});

test("the chart's time axis follows the horizon", async ({ page, user: _user, claude }) => {
  await importNordnet(page, claude);
  await page.goto("/forecast");
  const thisYear = new Date().getFullYear();
  const lastYearShown = async (): Promise<number> => {
    const labels = await page.getByText(/^\d\d\/\d{4}$/).allTextContents();
    return Math.max(...labels.map((label) => Number(label.slice(3))));
  };

  await page.getByRole("button", { name: "1 year", exact: true }).click();
  await expect.poll(lastYearShown).toBeGreaterThanOrEqual(thisYear);
  await expect.poll(lastYearShown).toBeLessThanOrEqual(thisYear + 1);
  await page.getByRole("button", { name: "20 years", exact: true }).click();
  await expect.poll(lastYearShown).toBeGreaterThanOrEqual(thisYear + 15);
});

test("today's euros and nominal euros give different figures", async ({
  page,
  user: _user,
  claude,
}) => {
  await importNordnet(page, claude);
  await page.goto("/forecast");
  const real = page.getByLabel("In today's euros");
  await expect(real).toBeChecked();
  await expect(
    page.getByText("Amounts are in today's euros at 2.00% inflation a year."),
  ).toBeVisible();
  await expect(page.getByText("In 10 years: €99.90")).toBeVisible();

  await real.uncheck();
  // 68 x 1.06 ^ 10, with no inflation taken off.
  await expect(page.getByText("In 10 years: €121.78")).toBeVisible();
  await expect(page.getByText(/Amounts are in today's euros/)).toHaveCount(0);

  await real.check();
  await expect(page.getByText("In 10 years: €99.90")).toBeVisible();
});

test("a yearly growth typed by hand replaces the default, and Reset brings it back", async ({
  page,
  user: _user,
  claude,
}) => {
  await importNordnet(page, claude);
  await page.goto("/forecast");
  const row = page.getByRole("row", { name: WISDOMTREE_ROW });
  const rate = row.getByLabel(/expected yearly growth in percent/);
  await expect(rate).toHaveValue("6.00");

  await rate.fill("5");
  await rate.press("Enter");
  // 68 x (1.05 / 1.02) ^ 10 = 90.87.
  await expect(row).toContainText("your rate");
  await expect(page.getByText("In 10 years: €90.87")).toBeVisible();

  await row.getByRole("button", { name: "Reset" }).click();
  await expect(rate).toHaveValue("6.00");
  await expect(row).toContainText("default, too little history");
  await expect(page.getByText("In 10 years: €99.90")).toBeVisible();
});

test("holdings without a price are named as left out, not valued", async ({
  page,
  user: _user,
  claude,
}) => {
  await importNordnet(page, claude);
  await page.goto("/forecast");
  // Inconsistent with Rebalance, which values HANetf New Theme (at the import's 6.00); reported to the owner as a possible app bug. The test pins only the two that are certainly unpriced.
  const leftOut = page.getByText(/^Left out, no price today: /);
  await expect(leftOut).toContainText("Nordnet Suomi Indeksi");
  await expect(leftOut).toContainText("HANetf Old Theme");
  await expect(page.getByRole("row", { name: /^Nordnet Suomi/ })).toHaveCount(0);
});

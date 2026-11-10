import type { Page } from "@playwright/test";

import { importNordnet } from "./harness/flows.ts";
import { expect, test } from "./harness/test.ts";

// The portfolio the Nordnet sample leaves: ETFs 140.00 (the WisdomTree buy, 2 x 34.00, and the 12 HANetf units at the 6.00 the import recorded) and cash 1,735.09. Prices come from the import, not the run date.
/** Euro cents in a line such as "ETFs: €3,984.99". */
const cents = (text: string): number =>
  Math.round(Number(text.replace(/^[^€]*€/, "").replaceAll(",", "")) * 100);

const PORTFOLIO = "€1,875.09";

/** Types ETFs 60 % and Cash 40 % into the first-time editor (one row per held slice) and saves. */
const saveTargets = async (page: Page): Promise<void> => {
  await page.getByLabel("ETFs target in percent").fill("60");
  await page.getByLabel("Cash target in percent").fill("40");
  await page.getByRole("button", { name: "Save targets" }).click();
  await expect(page.getByRole("cell", { name: "60.00 %" })).toBeVisible();
};

test("targets are refused until they add up, then the drift table shows each slice against its target", async ({
  page,
  user: _user,
  claude,
}) => {
  await importNordnet(page, claude);
  await page.goto("/rebalance");
  const save = page.getByRole("button", { name: "Save targets" });
  await expect(page.getByText("Without a target: Cash, ETFs.")).toBeVisible();
  await expect(save).toBeDisabled();

  await page.getByLabel("ETFs target in percent").fill("60");
  await page.getByLabel("Cash target in percent").fill("30");
  await expect(page.getByText(/^Total 90\.00 %/)).toContainText("must add up to 100 %");
  await expect(save).toBeDisabled();

  await page.getByLabel("Cash target in percent").fill("40");
  await expect(page.getByText(/^Total 100\.00 %/)).not.toContainText("must add up");
  await save.click();

  await expect(page.getByText(`Portfolio value ${PORTFOLIO}.`)).toBeVisible();
  // ETFs hold 140.00 of 1,875.09 = 7.47 %; cash is the rest. Euros to move come from the rounded shares: 52.53 % of the portfolio.
  await expect(page.getByRole("row", { name: /^ETFs 60\.00 %/ })).toContainText(
    "7.47 %-52.53 %€984.98",
  );
  await expect(page.getByRole("row", { name: /^Cash 40\.00 %/ })).toContainText(
    "92.53 %52.53 %-€984.98",
  );
  await expect(page.getByText("Without a target")).toHaveCount(0);

  await page.reload();
  await expect(page.getByLabel("ETFs target in percent")).toHaveValue("60.00");
  await expect(page.getByLabel("Cash target in percent")).toHaveValue("40.00");
});

test("a new investment is split between the slices and the parts add up to the amount typed", async ({
  page,
  user: _user,
  claude,
}) => {
  await importNordnet(page, claude);
  await page.goto("/rebalance");
  await saveTargets(page);
  await expect(page.getByText(`Portfolio value ${PORTFOLIO}.`)).toBeVisible();

  // 5000 closes both gaps. After it the portfolio is 6,875.09: ETFs want 60 % = 4,125.05, cash 2,750.03.
  // What each holds is taken from its rounded share of today's total (7.47 % = 140.07, 92.53 % = 1,735.02), so the gaps are 3,984.98 and 1,015.01; the one cent left goes to the largest part.
  await page.getByLabel("Amount").fill("5000");
  await expect(page.getByRole("listitem").filter({ hasText: /^ETFs: / })).toHaveText(
    "ETFs: €3,984.99",
  );
  await expect(page.getByRole("listitem").filter({ hasText: /^Cash: / })).toHaveText(
    "Cash: €1,015.01",
  );
  const parts = await page.getByRole("listitem").filter({ hasText: /: €/ }).allInnerTexts();
  expect(parts.map(cents).reduce((sum, part) => sum + part, 0)).toBe(500_000);
});

import { importNordnet, importNordnetOwnInstrument } from "./harness/flows.ts";
import { expect, test } from "./harness/test.ts";

test("holdings show cost-valued rows, and a sale of units never bought has no money figures", async ({
  page,
  user: _user,
  claude,
}) => {
  await importNordnet(page, claude);
  await page.goto("/holdings");

  // One BUY of 2 units at 34.00, no price on record: valued at cost.
  await expect(page.getByRole("row", { name: /WisdomTree/ })).toContainText("€68.00");
  // Sells 5 units of a fund it never bought: the quantity stays, cost and value are unknown.
  const unmatched = page.getByRole("row", { name: /Nordnet Suomi Indeksi/ });
  await expect(unmatched).toContainText("-5");
  await expect(unmatched.getByText("unknown")).toHaveCount(4);
});

test("a price recorded by hand changes the value", async ({ page, app, user: _user, claude }) => {
  await importNordnetOwnInstrument(page, app, claude);
  await page.goto("/holdings");
  const row = page.getByRole("row", { name: /WisdomTree/ });
  // Prices are shared by every user of the worker's database, so this test uses an instrument of its own.
  // The import recorded the trade price on its own date, long ago.
  await expect(row.getByText("stale")).toBeVisible();

  await row.getByRole("button", { name: "Enter price" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: /Enter a price for WisdomTree/ })).toBeVisible();
  await dialog.getByLabel("Price (EUR)").fill("40.00");
  await dialog.getByRole("button", { name: "Save price" }).click();

  // 2 units at 40.00, against a cost of 68.00.
  await expect(dialog).toBeHidden();
  await expect(row).toContainText("€80.00");
  await expect(row).toContainText("€12.00");
  await expect(row.getByText("stale")).toHaveCount(0);
});

test("editing an instrument saves the yearly fee, shown as set by the owner", async ({
  page,
  app,
  user: _user,
  claude,
}) => {
  await importNordnetOwnInstrument(page, app, claude);
  await page.goto("/holdings");
  const row = page.getByRole("row", { name: /WisdomTree/ });
  await expect(row).toContainText("–");

  await row.getByRole("button", { name: "Edit" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: /Edit WisdomTree/ })).toBeVisible();
  await dialog.getByLabel(/Yearly fee/).fill("0.25");
  await dialog.getByRole("button", { name: "Save" }).click();

  await expect(dialog).toBeHidden();
  await expect(row).toContainText("0.25%");
  await expect(row).toContainText("set by you");
});

import { expect, test } from "./harness/test.ts";
import {
  createBrokerAccount,
  importNordnet,
  nordnetWithUnseenIsin,
  previewNordnet,
  queueNordnetPreview,
  queueUnseenIsinImport,
  stubEmptyRegistry,
} from "./harness/flows.ts";

test("a Nordnet export previews 12 rows and imports 12 transactions", async ({
  page,
  user: _user,
  claude,
}) => {
  queueNordnetPreview(claude, true);
  await createBrokerAccount(page, "Nordnet");
  await previewNordnet(page);

  await expect(page.getByRole("heading", { name: /^Preview — nordnet-sample\.csv/ })).toBeVisible();
  await expect(page.getByText("12 rows to import")).toBeVisible();
  await page.getByRole("button", { name: /^Import 12 transactions$/ }).click();

  await expect(
    page.getByText("nordnet-sample.csv: 12 transactions imported, 0 skipped as duplicates."),
  ).toBeVisible();
});

test("importing the same file again skips all 12 as duplicates", async ({
  page,
  user: _user,
  claude,
}) => {
  await importNordnet(page, claude);

  queueNordnetPreview(claude, false);
  await previewNordnet(page);
  await page.getByRole("button", { name: /^Import 12 transactions$/ }).click();

  await expect(page.getByText("0 transactions imported, 12 skipped as duplicates")).toBeVisible();
});

test("the import history lists the commit", async ({ page, user: _user, claude }) => {
  await importNordnet(page, claude);

  const history = page.getByRole("row", { name: /nordnet-sample\.csv/ });
  await expect(history).toHaveCount(1);
  await expect(history.getByRole("cell", { name: "12", exact: true })).toBeVisible();
  await expect(history.getByRole("cell", { name: "active", exact: true })).toBeVisible();
  await expect(history.getByRole("button", { name: "Undo import" })).toBeVisible();
});

test("undoing the import marks it undone and empties Holdings", async ({
  page,
  user: _user,
  claude,
}) => {
  await importNordnet(page, claude);
  await page.goto("/holdings");
  await expect(page.getByRole("row", { name: /WisdomTree/ })).toBeVisible();

  await page.goto("/imports");
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Undo import" }).click();
  await expect(page.getByText("undone", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Undo import" })).toHaveCount(0);

  await page.goto("/holdings");
  await expect(page.getByText("No holdings.")).toBeVisible();
  await expect(page.getByRole("row", { name: /WisdomTree/ })).toHaveCount(0);
});

test("an ISIN the database has not seen asks for the instrument and commits once it is saved", async ({
  page,
  app,
  user: _user,
  claude,
}) => {
  const { isin, file } = nordnetWithUnseenIsin();
  const asked = stubEmptyRegistry(app);
  queueUnseenIsinImport(claude);

  await createBrokerAccount(page, "Nordnet");
  await previewNordnet(page, file);

  await expect(page.getByRole("heading", { name: "Unknown instruments" })).toBeVisible();
  await expect(page.getByText(isin, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Import \d+ transactions$/ })).toBeDisabled();

  await page.getByRole("combobox", { name: "Price source", exact: true }).selectOption("manual");
  await page.getByRole("button", { name: "Save instrument" }).click();

  const commit = page.getByRole("button", { name: /^Import 12 transactions$/ });
  await expect(commit).toBeEnabled();
  await commit.click();
  await expect(page.getByText("12 transactions imported, 0 skipped as duplicates")).toBeVisible();
  expect(asked.length, "registry lookups the form made").toBeGreaterThan(0);
});

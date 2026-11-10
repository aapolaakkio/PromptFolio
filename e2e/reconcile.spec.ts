import type { Page } from "@playwright/test";

import { importNordnet } from "./harness/flows.ts";
import { expect, test } from "./harness/test.ts";

const STATEMENT_DATE = "2025-12-31";
const WISDOMTREE = "WisdomTree Europe Defence UCITS ETF - EUR Acc";

/** What the Nordnet sample's ledger holds on the statement date, by instrument. */
const LEDGER = {
  [WISDOMTREE]: "2",
  "Nordnet Suomi Indeksi": "-5",
  "HANetf Old Theme UCITS ETF - Acc": "-30",
  "HANetf New Theme UCITS ETF - Acc": "12",
};

const openReconcile = async (page: Page): Promise<void> => {
  await page.goto("/reconcile");
  await expect(page.getByText("This account has no statements yet.")).toBeVisible();
};

/** Types a statement into the by-hand form and saves it. */
const saveByHand = async (page: Page, quantities: Record<string, string>): Promise<void> => {
  const form = page.getByRole("heading", { name: "Add a statement by hand" }).locator("..");
  await form.getByLabel("Statement date").fill(STATEMENT_DATE);
  for (const [name, quantity] of Object.entries(quantities)) {
    // Other tests of the worker register copies of an instrument under the same name; the seeded one is listed first.
    await form
      .getByRole("row", { name: new RegExp(`^${name}`) })
      .first()
      .getByRole("textbox")
      .fill(quantity);
  }
  await form.getByRole("button", { name: /^Save statement/ }).click();
};

/** A row of the result table (the one headed "Ledger"); the entry forms list the same names. */
const row = (page: Page, name: string) =>
  page
    .getByRole("table")
    .filter({ has: page.getByRole("columnheader", { name: "Ledger" }) })
    .getByRole("row", { name: new RegExp(`^${name}`) });

test("a typed statement that matches the ledger shows no differences", async ({
  page,
  user: _user,
  claude,
}) => {
  await importNordnet(page, claude);
  await openReconcile(page);

  await saveByHand(page, LEDGER);

  await expect(page.getByText("All 4 rows match on 31/12/2025.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Explain differences" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Adjust" })).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Statement" })).toContainText(
    "31/12/2025 · Entered by hand",
  );
});

test("a typed statement that differs names the instrument and the gap", async ({
  page,
  user: _user,
  claude,
}) => {
  await importNordnet(page, claude);
  await openReconcile(page);

  await saveByHand(page, { ...LEDGER, [WISDOMTREE]: "3" });

  await expect(page.getByText("1 / 4 rows differ on 31/12/2025.")).toBeVisible();
  const differing = row(page, WISDOMTREE);
  await expect(differing).toContainText("Units missing from the ledger");
  await expect(differing.getByRole("cell", { name: "1", exact: true })).toBeVisible();
  await expect(differing.getByRole("button", { name: "Adjust" })).toBeVisible();
  await expect(row(page, "Nordnet Suomi Indeksi")).toContainText("Matches");
  await expect(page.getByRole("button", { name: "Explain differences" })).toBeVisible();
});

test("a pasted table is read by Claude's recipe, matched to the instruments and reconciled", async ({
  page,
  user: _user,
  claude,
}) => {
  await importNordnet(page, claude);
  await openReconcile(page);
  // One call: the recipe for this table's layout. Nothing else asks Claude on this page.
  claude.replyRecipe("holdings-table");
  const asked = claude.requests.length;
  const table = [
    "Nimi\tValuutta\tMäärä\tArvo EUR",
    "Nordnet Suomi Indeksi\tEUR\t-5\t500,00",
    "HANetf Old Theme UCITS ETF - Acc\tEUR\t-30\t0,00",
    "HANetf New Theme UCITS ETF - Acc\tEUR\t13\t300,00",
  ].join("\n");

  const paste = page.getByRole("heading", { name: "Paste holdings" }).locator("..");
  await paste.getByLabel("Statement date").fill(STATEMENT_DATE);
  await paste.getByLabel(/or paste a table/).fill(table);
  await paste.getByRole("button", { name: "Read table" }).click();
  // The names are the instruments' own, so every row is matched already. WisdomTree is left out: other tests of the worker register copies of it under the same name, and the paste matches a name to the last of them.
  await paste.getByRole("button", { name: "Save statement" }).click();

  await expect(page.getByText("2 / 4 rows differ on 31/12/2025.")).toBeVisible();
  await expect(row(page, WISDOMTREE)).toContainText("Only in the ledger");
  await expect(row(page, "HANetf New Theme UCITS ETF - Acc")).toContainText(
    "Units missing from the ledger",
  );
  await expect(row(page, "Nordnet Suomi Indeksi")).toContainText("Matches");
  expect(claude.requests).toHaveLength(asked + 1);
});

test("a statement is deleted after the confirm", async ({ page, user: _user, claude }) => {
  await importNordnet(page, claude);
  await openReconcile(page);
  await saveByHand(page, LEDGER);
  await expect(page.getByText("All 4 rows match on 31/12/2025.")).toBeVisible();

  page.once("dialog", (dialog) => {
    expect(dialog.message()).toBe(
      "Delete this statement? Adjustments made from it stay in effect.",
    );
    void dialog.dismiss();
  });
  await page.getByRole("button", { name: "Delete statement" }).click();
  await expect(page.getByText("All 4 rows match on 31/12/2025.")).toBeVisible();

  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Delete statement" }).click();
  await expect(page.getByText("This account has no statements yet.")).toBeVisible();
});

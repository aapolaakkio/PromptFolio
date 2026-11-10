import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Page } from "@playwright/test";

import {
  createBankAccount,
  createBrokerAccount,
  nordnetFile,
  opFile,
  type UploadFile,
} from "./harness/flows.ts";
import { expect, test } from "./harness/test.ts";

const DROP_INPUT = /Any bank or broker files/;
const OP_PDF = resolve("src/server/import/fixtures/op-statement-sample.pdf");

/** The id the database gave an account, read from the page's own account list. */
const accountId = async (page: Page, name: string): Promise<number> => {
  await page.goto("/imports");
  const value = await page
    .getByRole("combobox", { name: "Account", exact: true })
    .getByRole("option", { name, exact: true })
    .getAttribute("value");
  expect(value).toMatch(/^\d+$/);
  return Number(value);
};

const NEW_LAYOUT = [
  "Posted,Memo,Payee,Debit,Credit,TxnRef",
  "2026-03-02,CARD PURCHASE,Harbour Bakery,4.50,,NW0001",
  "2026-03-03,PAY,Lantern Works Ltd,,1200.00,NW0002",
  "2026-03-05,CARD PURCHASE,Pinewood Books,18.20,,NW0003",
].join("\n");

const newLayoutFile = (): UploadFile => ({
  name: "northwind-march.csv",
  mimeType: "text/csv",
  buffer: Buffer.from(NEW_LAYOUT, "utf8"),
});

test("two files dropped at once are each placed on their own account", async ({
  page,
  user: _user,
  claude,
}) => {
  await createBrokerAccount(page, "Nordnet");
  await createBankAccount(page, "Everyday");
  const brokerId = await accountId(page, "Nordnet");
  const bankId = await accountId(page, "Everyday");
  claude.replyJson({
    files: [
      { index: 0, kind: "broker-transactions", accountId: brokerId, reason: "Nordnet export" },
      { index: 1, kind: "bank-statement", accountId: bankId, reason: "OP account export" },
    ],
  });

  await page.getByLabel(DROP_INPUT).setInputFiles([nordnetFile(), opFile()]);

  await expect(
    page.getByText("Detected: broker transactions → Nordnet. Nordnet export"),
  ).toBeVisible();
  await expect(
    page.getByText("Detected: bank statement → Everyday. OP account export"),
  ).toBeVisible();
  await expect(page.getByLabel("Account for nordnet-sample.csv")).toHaveValue(String(brokerId));
  await expect(page.getByLabel("Account for op-bank-sample.csv")).toHaveValue(String(bankId));
  await expect(
    page.getByRole("heading", { name: "broker transactions · Nordnet (1)" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "bank statement · Everyday (1)" })).toBeVisible();

  // One call sorted both files, and it was shown their names.
  expect(claude.requests).toHaveLength(1);
  expect(claude.requests[0]?.lastUser).toContain("nordnet-sample.csv");
  expect(claude.requests[0]?.lastUser).toContain("op-bank-sample.csv");
});

test("a file the model cannot place is left for the owner", async ({
  page,
  user: _user,
  claude,
}) => {
  await createBrokerAccount(page, "Nordnet");
  claude.replyJson({
    files: [{ index: 0, kind: "unknown", accountId: null, reason: "A shopping list" }],
  });

  await page.getByLabel(DROP_INPUT).setInputFiles({
    name: "groceries.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("milk\nbread\neggs\n", "utf8"),
  });

  await expect(
    page.getByText("Detected: not recognised → no account. A shopping list"),
  ).toBeVisible();
  await expect(page.getByLabel("Kind of groceries.txt")).toHaveValue("unknown");
  await expect(page.getByLabel("Account for groceries.txt")).toHaveValue("");
  // Nothing is offered for the file until the owner chooses what it is.
  await expect(page.getByRole("heading", { name: /not recognised ·/ })).toHaveCount(0);
});

test("an OP PDF statement previews its rows and matches the closing balance", async ({
  page,
  user: _user,
  claude,
}) => {
  await createBankAccount(page, "Everyday");
  claude.replyRecipe("op-pdf");
  await page.goto("/imports");
  await page
    .getByRole("combobox", { name: "Account", exact: true })
    .selectOption({ label: "Everyday" });

  await page.getByLabel("Bank statements").setInputFiles({
    name: "op-statement-sample.pdf",
    mimeType: "application/pdf",
    buffer: readFileSync(OP_PDF),
  });
  await page.getByRole("button", { name: "Preview" }).click();

  await expect(page.getByText(/^Bank statement .*balance/)).toBeVisible();
  await expect(page.getByText("The rows match the closing balance.")).toBeVisible();
  await expect(page.getByRole("cell", { name: "K-MARKET ESIMERKKI" })).toBeVisible();

  await page.getByRole("button", { name: "Import", exact: true }).click();
  await expect(page.getByText("2 new transactions, 0 already imported.")).toBeVisible();
  await expect(page.getByText("The balance matches the bank statement.")).toBeVisible();
});

test("a new bank layout asks Claude for a recipe and previews the rows it reads", async ({
  page,
  user: _user,
  claude,
}) => {
  await createBankAccount(page, "Everyday");
  claude.replyJson({
    kind: "bank-csv",
    delimiter: ",",
    columns: {
      date: "Posted",
      amount: null,
      debit: "Debit",
      credit: "Credit",
      label: "Memo",
      counterparty: "Payee",
      message: null,
      externalId: "TxnRef",
    },
    dateFormat: "yyyy-mm-dd",
    money: { decimal: ".", thousands: "", negative: "leading", twoColumn: true },
    interestLabels: [],
  });
  await page.goto("/imports");
  await page
    .getByRole("combobox", { name: "Account", exact: true })
    .selectOption({ label: "Everyday" });

  await page.getByLabel("Bank statements").setInputFiles(newLayoutFile());
  await page.getByRole("button", { name: "Preview" }).click();

  await expect(page.getByRole("button", { name: "Import", exact: true })).toBeEnabled();
  await expect(page.getByRole("cell", { name: "Harbour Bakery" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Lantern Works Ltd" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Pinewood Books" })).toBeVisible();
  // One call only: the recipe was accepted on its first answer.
  expect(claude.requests).toHaveLength(1);
  expect(claude.requests[0]?.lastUser).toContain("Harbour Bakery");
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

import type { Claude } from "./claude.ts";

export const NORDNET_FIXTURE = resolve("src/server/import/fixtures/nordnet-sample.csv");

export type UploadFile = {
  readonly name: string;
  readonly mimeType: string;
  readonly buffer: Buffer;
};

/** The fixture as raw bytes: it is UTF-16LE, and re-encoding breaks broker sniffing. */
export const nordnetFile = (bytes: Buffer = readFileSync(NORDNET_FIXTURE)): UploadFile => ({
  name: "nordnet-sample.csv",
  mimeType: "text/csv",
  buffer: bytes,
});

/** Opens Imports and creates a broker account (the first form, or the "+ New account" one), leaving it selected. */
export const createBrokerAccount = async (page: Page, name: string): Promise<void> => {
  await page.goto("/imports");
  const newAccount = page.getByRole("button", { name: "+ New account" });
  if (await newAccount.isVisible()) await newAccount.click();
  await page.getByLabel("Account name").fill(name);
  await page.getByRole("combobox", { name: "Broker", exact: true }).selectOption("nordnet");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("combobox", { name: "Account", exact: true })).toHaveValue(/\d+/);
};

/** Queues what one Nordnet Preview asks Claude: the recipe only the first time, then the corporate-action proposal call. */
export const queueNordnetPreview = (claude: Claude, firstTime: boolean): void => {
  if (firstTime) claude.replyRecipe("nordnet");
  claude.replyJson({ actions: [] });
};

/** Picks the file and presses Preview; the account must already be selected on /imports. */
export const previewNordnet = async (
  page: Page,
  file: UploadFile = nordnetFile(),
): Promise<void> => {
  await page.getByLabel(/Broker CSV or PDF files/).setInputFiles(file);
  await page.getByRole("button", { name: "Preview" }).click();
};

/** A user with a Nordnet account that holds the sample's 12 transactions. Ends on /imports after the commit. */
export const importNordnet = async (page: Page, claude: Claude): Promise<void> => {
  queueNordnetPreview(claude, true);
  await createBrokerAccount(page, "Nordnet");
  await previewNordnet(page);
  await page.getByRole("button", { name: /^Import 12 transactions$/ }).click();
  await expect(page.getByText("12 transactions imported, 0 skipped as duplicates")).toBeVisible();
};

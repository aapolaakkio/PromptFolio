import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

import type { Claude } from "./claude.ts";
import type { App } from "./test.ts";

const SEEDED_ISIN = "IE0002Y8CX98";
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
  const firstForm = page.getByLabel("Account name");
  // Until the accounts load neither shows; which one does tells whether the user has accounts.
  await expect(newAccount.or(firstForm)).toBeVisible();
  const account = page.getByRole("combobox", { name: "Account", exact: true });
  const before = await account.inputValue();
  if (await newAccount.isVisible()) await newAccount.click();
  await firstForm.fill(name);
  await page.getByRole("combobox", { name: "Broker", exact: true }).selectOption("nordnet");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(account).not.toHaveValue(before);
  await expect(account).toHaveValue(/\d+/);
};

/** Queues what one Nordnet Preview asks Claude: the recipe only when the user has none stored yet, then the corporate-action proposal call. */
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

export type ImportOptions = {
  /** Name of the account to create. */
  readonly account?: string;
  /** False when this user's recipe is already stored (an earlier import in the same test). */
  readonly recipe?: boolean;
};

/** A user with a Nordnet account that holds the sample's 12 transactions. Ends on /imports after the commit. */
export const importNordnet = async (
  page: Page,
  claude: Claude,
  { account = "Nordnet", recipe = true }: ImportOptions = {},
): Promise<void> => {
  queueNordnetPreview(claude, recipe);
  await createBrokerAccount(page, account);
  await previewNordnet(page);
  await page.getByRole("button", { name: /^Import 12 transactions$/ }).click();
  await expect(page.getByText("12 transactions imported, 0 skipped as duplicates")).toBeVisible();
};

export type UnseenIsin = { readonly isin: string; readonly file: UploadFile };

/** A copy of the sample whose WisdomTree rows carry an ISIN no database has seen: instruments and their prices are shared by every user of a worker's database and outlive the test. */
export const nordnetWithUnseenIsin = (): UnseenIsin => {
  // 9 hex characters of a UUID are letters A-F and digits: a valid ISIN body.
  const isin = `XS${randomUUID().replaceAll("-", "").slice(0, 9).toUpperCase()}7`;
  const text = readFileSync(NORDNET_FIXTURE).toString("utf16le").replaceAll(SEEDED_ISIN, isin);
  return { isin, file: nordnetFile(Buffer.from(text, "utf16le")) };
};

/** OpenFIGI knows nothing of the ISIN: the unknown-instrument form opens empty. Returns the paths asked. */
export const stubEmptyRegistry = (app: App): string[] => {
  const asked: string[] = [];
  app.upstream.on("api.openfigi.com", (call) => {
    asked.push(call.path);
    return new Response("[]", { headers: { "content-type": "application/json" } });
  });
  return asked;
};

/** Claude's part of a first Preview of an unseen ISIN (recipe, price-page finder finds none, proposals) plus the re-preview after the instrument is saved. */
export const queueUnseenIsinImport = (claude: Claude): void => {
  claude.replyRecipe("nordnet");
  claude.replyJson({ url: null, isin: null });
  claude.replyJson({ actions: [] });
  queueNordnetPreview(claude, false);
};

/** Imports the sample under an ISIN only this test uses, registering it as an own-price instrument: its price and fee edits touch no other test's data. */
export const importNordnetOwnInstrument = async (
  page: Page,
  app: App,
  claude: Claude,
): Promise<string> => {
  const { isin, file } = nordnetWithUnseenIsin();
  stubEmptyRegistry(app);
  queueUnseenIsinImport(claude);
  await createBrokerAccount(page, "Nordnet");
  await previewNordnet(page, file);
  await page.getByRole("combobox", { name: "Price source", exact: true }).selectOption("manual");
  await page.getByRole("button", { name: "Save instrument" }).click();
  await page.getByRole("button", { name: /^Import 12 transactions$/ }).click();
  await expect(page.getByText("12 transactions imported, 0 skipped as duplicates")).toBeVisible();
  return isin;
};

export const OP_FIXTURE = resolve("src/server/import/fixtures/op-bank-sample.csv");

/** Opens Cash and creates a bank account, leaving it the selected one. */
export const createBankAccount = async (page: Page, name: string): Promise<void> => {
  await page.goto("/cash");
  await page.getByRole("button", { name: "+ New bank account" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Account name").fill(name);
  await dialog.getByRole("combobox", { name: "Account kind" }).selectOption("bank");
  await dialog.getByRole("button", { name: "Create account" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("combobox", { name: "Bank account" })).toContainText(name);
};

export const opFile = (text: string = readFileSync(OP_FIXTURE, "utf8")): UploadFile => ({
  name: "op-bank-sample.csv",
  mimeType: "text/csv",
  buffer: Buffer.from(text, "utf8"),
});

export type OpImportOptions = {
  /** The bank account to import into, by name. */
  readonly account: string;
  /** False when this user's OP recipe is already stored (an earlier OP import in the same test). */
  readonly recipe?: boolean;
  readonly file?: UploadFile;
  /** What the payee classifier answers after the commit; omit when the file holds no payee without a rule. */
  readonly classifier?: Parameters<Claude["replyJson"]>[0];
};

/** Imports an OP CSV into an existing bank account through Imports. Ends on /imports after the commit. */
export const importOpCsv = async (
  page: Page,
  claude: Claude,
  { account, recipe = true, file = opFile(), classifier }: OpImportOptions,
): Promise<void> => {
  if (recipe) claude.replyRecipe("op-csv");
  if (classifier !== undefined) claude.replyJson(classifier);
  await page.goto("/imports");
  await page
    .getByRole("combobox", { name: "Account", exact: true })
    .selectOption({ label: account });
  await page.getByLabel("Bank statements").setInputFiles(file);
  await page.getByRole("button", { name: "Preview" }).click();
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await expect(page.getByText(/\d+ new transactions, \d+ already imported/)).toBeVisible();
};

import { listAccounts } from "../accounts.ts";
import { HttpError } from "../errors.ts";
import type { AssistantPage, PageContext } from "./page-context.ts";
import { maskAccountNumbers } from "./mask.ts";
import { accountName, ownInstrument } from "./proposal-kit.ts";
import type { Db } from "./tool-types.ts";

const PAGE_NAMES = {
  dashboard: "Dashboard",
  holdings: "Holdings",
  reconcile: "Reconcile",
  cash: "Cash",
  spending: "Spending",
  rebalance: "Rebalance",
  forecast: "Forecast",
  tax: "Tax",
  imports: "Imports",
  chat: "Chat",
} as const satisfies Record<AssistantPage, string>;

const accountPart = async (db: Db, userId: string, accountId: number): Promise<string> => {
  const account = (await listAccounts(db, userId)).find((candidate) => candidate.id === accountId);
  if (account === undefined) throw new HttpError(404, "Account not found");
  return `Selected account: ${maskAccountNumbers(accountName(account))}.`;
};

const instrumentPart = async (db: Db, userId: string, instrumentId: number): Promise<string> => {
  // ownInstrument throws a plain Error for the model; here the browser asked, so it is a 404.
  const instrument = await ownInstrument(db, userId, instrumentId).catch(() => {
    throw new HttpError(404, "Instrument not found");
  });
  const isin = instrument.isin === null ? "" : ` (${instrument.isin})`;
  return `Selected instrument: ${JSON.stringify(instrument.name)}${isin}.`;
};

/** The one system line about where the owner is, written by the app from resolved names; a foreign id is refused. */
export const pageLine = async (db: Db, userId: string, context: PageContext): Promise<string> => {
  const { accountId, instrumentId } = context.selection ?? {};
  const parts = [
    `The owner is on the ${PAGE_NAMES[context.page]} page.`,
    accountId === undefined ? null : await accountPart(db, userId, accountId),
    instrumentId === undefined ? null : await instrumentPart(db, userId, instrumentId),
  ];
  return parts.filter((part) => part !== null).join(" ");
};

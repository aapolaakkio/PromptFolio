import {
  formatMoney,
  formatQuantity,
  parseMoney,
  type Currency,
  type Quantity,
} from "../../core/money.ts";
import { and, eq } from "drizzle-orm";

import { assertAccountOwned, listAccounts } from "../accounts.ts";
import { accounts, snapshots } from "../db/schema.ts";
import { HttpError } from "../errors.ts";
import { isPublicPageUrl } from "../prices/page.ts";
import { loadPortfolio } from "../valuation.ts";
import type { Fact } from "./proposal-schema.ts";
import type { Db } from "./tool-types.ts";

// What every proposal tool shares: ids, the app's own wording of names and amounts, and ownership checks.

export const newId = (): string => crypto.randomUUID();

/** A validated amount as the canonical "1234.50" the card formats; refused rather than guessed. */
export const canonical = (amount: string, currency: Currency): string => {
  try {
    return formatMoney(parseMoney(amount, currency));
  } catch {
    throw new Error("The amount is not a valid decimal number");
  }
};

export const text = (label: string, value: string): Fact => ({ kind: "text", label, text: value });

export const money = (label: string, amount: string, currency: string): Fact => ({
  kind: "money",
  label,
  amount,
  currency,
});

type Named = { readonly name: string; readonly isin: string | null };
export const instrumentLabel = (instrument: Named): string =>
  instrument.isin === null ? instrument.name : `${instrument.name} (${instrument.isin})`;

/** The household registry is shared, so a proposal may only name an instrument this user's own ledger references. */
export const ownInstrument = async (db: Db, userId: string, id: number) => {
  const { txns, instruments } = await loadPortfolio(db, userId);
  const instrument = instruments.find((candidate) => candidate.id === id);
  if (instrument === undefined || !txns.some((txn) => txn.instrumentId === id)) {
    throw new Error("Instrument not found");
  }
  return instrument;
};

export const accountName = (account: { readonly name: string; readonly id: number }): string =>
  `${account.name} (account #${account.id})`;

/** The same check the forms run; its 404 text goes back to the model with the ids it may use. Named with its id, since two accounts may share a name. */
export const ownAccount = async (db: Db, userId: string, accountId: number) => {
  const accounts = await listAccounts(db, userId);
  try {
    await assertAccountOwned(userId, accountId);
  } catch (cause) {
    if (!(cause instanceof HttpError)) throw cause;
    const known = accounts.map((account) => `${account.id} (${account.name})`).join(", ");
    throw new Error(`${cause.message}. The owner's accounts: ${known || "none"}`);
  }
  const account = accounts.find((candidate) => candidate.id === accountId);
  if (account === undefined) throw new Error("Account not found");
  return account;
};

export const ownAccountLabel = async (db: Db, userId: string, accountId: number) =>
  accountName(await ownAccount(db, userId, accountId));

/** A quantity without the trailing zeros of its fixed scale: "12.5", not "12.500000". */
export const quantityText = (quantity: Quantity): string => {
  const fixed = formatQuantity(quantity);
  return fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed;
};

/** One of the caller's holdings statements, with its account; another owner's reads as missing. */
export const ownSnapshot = async (db: Db, userId: string, snapshotId: number) => {
  const row = await db
    .select({ snapshot: snapshots, account: accounts })
    .from(snapshots)
    .innerJoin(accounts, eq(accounts.id, snapshots.accountId))
    .where(and(eq(snapshots.id, snapshotId), eq(accounts.userId, userId)))
    .get();
  if (row === undefined) throw new Error("Snapshot not found");
  return row;
};

const TICKER = /^[A-Z0-9.^=-]{1,20}$/;

/** A ticker the card may show: model text is never displayed unvalidated. */
export const shownTicker = (ticker: string): string => {
  if (!TICKER.test(ticker)) {
    throw new Error("A Yahoo ticker is upper-case letters, digits and . ^ = - only");
  }
  return ticker;
};

/** The code the card shows, checked first: model text is never displayed unvalidated. */
export const shownCode = (priceSource: "yahoo" | "page" | "manual", key: string): string | null => {
  switch (priceSource) {
    case "page":
      if (!isPublicPageUrl(key)) throw new Error("A page source needs a public https URL");
      return new URL(key).href;
    case "yahoo":
      return shownTicker(key);
    case "manual":
      if (key !== "") throw new Error("A manual source takes no code; leave sourceKey empty");
      return null;
  }
};

/** A fund's fee is reference data every household member sees, so its cards say so. */
export const HOUSEHOLD_SHARED = {
  kind: "text",
  label: "Applies to",
  text: "Shared by everyone in the household",
} as const satisfies Fact;

/** Who wrote a spending rule, as a card says it. */
export const RULE_MADE_BY = {
  user: "You",
  ai: "The assistant",
  seed: "Built into the app",
} as const;

export const AWAITS = " Saves nothing: the owner sees a card and decides with Confirm or Dismiss.";

/** Every removal tool ends with this, so the model proposes one only on the owner's own request. */
export const REMOVAL_RULES =
  " Propose a removal only when the owner asked for it in their own message, one thing per " +
  "proposal, never 'all'. If more than one thing matches, list what you found and ask which " +
  "one before proposing. Removes nothing: the owner sees a warning card and decides.";

export const ASK_WHEN_UNSURE =
  " If a name is unknown or matches several, ask the owner instead of proposing.";

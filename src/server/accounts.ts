import { and, eq } from "drizzle-orm";
import type { z } from "zod";

import { BANK_TYPES, BROKERAGE_TYPES, CreateAccount, UpdateAccount } from "./action-inputs.ts";
import { type Db, db } from "./db/index.ts";
import { accounts } from "./db/schema.ts";
import { HttpError } from "./errors.ts";

const sharedDb = db;

const typesFor = (kind: "brokerage" | "bank"): readonly string[] =>
  kind === "bank" ? BANK_TYPES : BROKERAGE_TYPES;

type AccountType = z.infer<typeof CreateAccount>["accountType"];

/** The wire rate ("3.25") in basis points, as stored. */
const rateBp = (text: string): number => Math.round(Number(text.replace(",", ".")) * 100);

/** Terms are refused where meaningless rather than stored and ignored: a rate fits either savings kind, a maturity date only a fixed-term deposit. */
export const assertTermsMatchType = (
  type: AccountType | null | undefined,
  body: { maturityDate?: string | null; interestRate?: string | null },
): void => {
  if ((body.maturityDate ?? null) !== null && type !== "fixed_term") {
    throw new HttpError(400, "A maturity date applies only to fixed-term accounts");
  }
  if ((body.interestRate ?? null) !== null && !BANK_TYPES.some((known) => known === type)) {
    throw new HttpError(400, "An interest rate applies only to bank accounts");
  }
};

/** An account's type must belong to its kind. Refused, not corrected: "a savings account that is an equity savings account" has no obvious fix. */
export const assertTypeMatchesKind = (
  kind: "brokerage" | "bank",
  type: AccountType | null | undefined,
): void => {
  if (type === null || type === undefined) return;
  if (!typesFor(kind).includes(type)) {
    const allowed = typesFor(kind).join(", ");
    throw new HttpError(
      400,
      `Account type ${type} does not fit kind ${kind} (allowed: ${allowed})`,
    );
  }
};

/** Confirms the account belongs to the user, else 404 (the same as a missing one). Anything taking an account id from a caller runs this first. */
export const assertAccountOwned = async (userId: string, accountId: number): Promise<void> => {
  const owned = await sharedDb
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.userId, userId)))
    .get();
  if (!owned) throw new HttpError(404, "Account not found");
};

export const listAccounts = async (db: Db, userId: string) => {
  return await db.select().from(accounts).where(eq(accounts.userId, userId)).all();
};

export const openAccount = async (db: Db, userId: string, body: z.infer<typeof CreateAccount>) => {
  assertTypeMatchesKind(body.kind, body.accountType);
  assertTermsMatchType(body.accountType, body);
  const created = await db
    .insert(accounts)
    .values({
      name: body.name,
      broker: body.broker,
      baseCurrency: body.baseCurrency,
      kind: body.kind,
      accountType: body.accountType ?? null,
      maturityDate: body.maturityDate ?? null,
      interestRateBp: body.interestRate ? rateBp(body.interestRate) : null,
      userId,
    })
    .returning()
    .get();
  return created;
};

export const updateAccount = async (
  db: Db,
  userId: string,
  accountId: number,
  body: z.infer<typeof UpdateAccount>,
) => {
  await assertAccountOwned(userId, accountId);

  // Only fields the request carried: an absent `name` or type must not clear the stored one, an explicit null type does. Terms are checked against the type the account will HAVE after this request (type and maturity are set together).
  const current = await db.select().from(accounts).where(eq(accounts.id, accountId)).get();
  // The kind is fixed at creation: turning a brokerage account into a bank one would drop its holdings from the return figures.
  if (current) {
    assertTypeMatchesKind(
      current.kind,
      body.accountType === undefined ? (current.accountType ?? null) : body.accountType,
    );
  }
  assertTermsMatchType(
    body.accountType === undefined ? (current?.accountType ?? null) : body.accountType,
    body,
  );

  const named = body.name === undefined ? {} : { name: body.name };
  const typed = body.accountType === undefined ? {} : { accountType: body.accountType };
  const matures = body.maturityDate === undefined ? {} : { maturityDate: body.maturityDate };
  const rate =
    body.interestRate === undefined
      ? {}
      : { interestRateBp: body.interestRate === null ? null : rateBp(body.interestRate) };
  const changes = { ...named, ...typed, ...matures, ...rate } satisfies Partial<
    typeof accounts.$inferInsert
  >;
  return db
    .update(accounts)
    .set(changes)
    .where(and(eq(accounts.id, accountId), eq(accounts.userId, userId)))
    .returning()
    .get();
};

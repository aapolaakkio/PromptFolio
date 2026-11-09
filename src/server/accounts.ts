import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { EUR } from "../core/money.ts";
import { currencyField } from "./currency-field.ts";
import { type Db, db } from "./db/index.ts";
import { accounts } from "./db/schema.ts";
import { HttpError } from "./errors.ts";

const sharedDb = db;

const accountKind = z.enum(["brokerage", "bank"]);

/** Each kind's own types: brokerage is a regular securities account or an equity savings account (OST, which decides taxation); bank is current, savings or fixed-term (which decides whether money can be reached). Kept apart: neither set means anything for the other kind. */
const BROKERAGE_TYPES = ["aot", "ost", "other"] as const;
// "credit" is a bank-kind account holding no money of its own (card purchases and settling payments), kept out of cash figures (see valuation.ts `cashTxns`); no rate or maturity.
const BANK_TYPES = ["current", "savings", "fixed_term", "credit"] as const;

const accountType = z.enum([...BROKERAGE_TYPES, ...BANK_TYPES]);

const typesFor = (kind: "brokerage" | "bank"): readonly string[] =>
  kind === "bank" ? BANK_TYPES : BROKERAGE_TYPES;

const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in the format YYYY-MM-DD");

/** A fixed-term deposit's terms. The rate is a decimal string ("3.25") on the wire and basis points in storage. */
const interestRate = z
  .string()
  .regex(/^\d{1,2}([.,]\d{1,2})?$/, "Rate in the format 3.25")
  .transform((text) => Math.round(Number(text.replace(",", ".")) * 100));

const terms = {
  maturityDate: IsoDateSchema.nullable().optional(),
  interestRate: interestRate.nullable().optional(),
};

/** Terms are refused where meaningless rather than stored and ignored: a rate fits either savings kind, a maturity date only a fixed-term deposit. */
const assertTermsMatchType = (
  type: z.infer<typeof accountType> | null | undefined,
  body: { maturityDate?: string | null; interestRate?: number | null },
): void => {
  if ((body.maturityDate ?? null) !== null && type !== "fixed_term") {
    throw new HttpError(400, "A maturity date applies only to fixed-term accounts");
  }
  if ((body.interestRate ?? null) !== null && !BANK_TYPES.some((known) => known === type)) {
    throw new HttpError(400, "An interest rate applies only to bank accounts");
  }
};

/** An account's type must belong to its kind. Refused, not corrected: "a savings account that is an equity savings account" has no obvious fix. */
const assertTypeMatchesKind = (
  kind: "brokerage" | "bank",
  type: z.infer<typeof accountType> | null | undefined,
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

/** Name and type only: broker and base currency are what stored rows were interpreted under. The type is editable because it decides tax treatment and a guessed, frozen one makes a tax report confidently wrong. */
export const UpdateAccount = z
  .object({
    name: z.string().trim().min(1, "Name cannot be empty").max(100).optional(),
    accountType: accountType.nullable().optional(),
    ...terms,
  })
  .refine(
    (body) =>
      body.name !== undefined ||
      body.accountType !== undefined ||
      body.maturityDate !== undefined ||
      body.interestRate !== undefined,
    { message: "No fields to change" },
  );

export const CreateAccount = z.object({
  name: z.string().min(1).max(100),
  broker: z.enum(["nordnet", "op", "spankki", "danske", "other"]),
  baseCurrency: currencyField.default(EUR),
  kind: accountKind.default("brokerage"),
  // Optional at creation: an owner importing an export may not know yet which account it covers.
  accountType: accountType.optional(),
  ...terms,
});

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
      interestRateBp: body.interestRate ?? null,
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
  const rate = body.interestRate === undefined ? {} : { interestRateBp: body.interestRate };
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

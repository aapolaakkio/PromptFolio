import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { EUR } from "../core/money.ts";
import { requireUser } from "./auth-guard.ts";
import { currencyField } from "./currency-field.ts";
import { getDb } from "./db/index.ts";
import { accounts } from "./db/schema.ts";
import { HttpError } from "./errors.ts";

type Db = ReturnType<typeof getDb>["db"];

const { db: sharedDb } = getDb();

const accountKind = z.enum(["brokerage", "bank"]);

/**
 * Each kind's own types. A brokerage account is an arvo-osuustili or an
 * osakesäästötili, which decides how it is taxed; a bank account is a current,
 * savings or fixed-term one, which decides whether the money can be reached.
 * Neither set means anything applied to the other kind, so they are kept apart
 * rather than offered as one list nobody can pick wrongly from by accident.
 */
const BROKERAGE_TYPES = ["aot", "ost", "other"] as const;
// "credit" is a bank-kind account that holds no money of its own: its rows are
// card purchases and the payments that settle them. Kept out of the cash
// figures (see valuation.ts's `cashTxns`), and it carries no interest rate or
// maturity, so it belongs here rather than among the savings kinds.
const BANK_TYPES = ["current", "savings", "fixed_term", "credit"] as const;

const accountType = z.enum([...BROKERAGE_TYPES, ...BANK_TYPES]);

const typesFor = (kind: "brokerage" | "bank"): readonly string[] =>
  kind === "bank" ? BANK_TYPES : BROKERAGE_TYPES;

const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Päivämäärän on oltava muotoa YYYY-MM-DD");

/**
 * A fixed-term deposit's terms. The rate crosses the wire as a decimal string
 * ("3.25") and is stored in basis points, the same discipline money follows:
 * nothing that has to be exact travels as a JSON number.
 */
const interestRate = z
  .string()
  .regex(/^\d{1,2}([.,]\d{1,2})?$/, "Korko muodossa 3.25")
  .transform((text) => Math.round(Number(text.replace(",", ".")) * 100));

const terms = {
  maturityDate: IsoDateSchema.nullable().optional(),
  interestRate: interestRate.nullable().optional(),
};

/**
 * Terms belong to the account kinds that can carry them, and are refused rather
 * than stored-and-ignored anywhere else: a maturity date sitting on a brokerage
 * account is a claim nobody will re-check, and the screen that later reads it
 * has no way to know it was meaningless.
 *
 * A rate fits either savings kind. A maturity date fits only a fixed-term
 * deposit -- an ordinary savings account's money is available at any time, which
 * is exactly what separates the two.
 */
const assertTermsMatchType = (
  type: z.infer<typeof accountType> | null | undefined,
  body: { maturityDate?: string | null; interestRate?: number | null },
): void => {
  if ((body.maturityDate ?? null) !== null && type !== "fixed_term") {
    throw new HttpError(400, "Eräpäivä koskee vain määräaikaistiliä");
  }
  if ((body.interestRate ?? null) !== null && !BANK_TYPES.some((known) => known === type)) {
    throw new HttpError(400, "Korko koskee vain pankkitilejä");
  }
};

/**
 * An account's type has to belong to its own kind. Refused rather than
 * corrected: "a savings account that is an osakesäästötili" is not a typo with
 * an obvious fix, it is a request nobody can act on.
 */
const assertTypeMatchesKind = (
  kind: "brokerage" | "bank",
  type: z.infer<typeof accountType> | null | undefined,
): void => {
  if (type === null || type === undefined) return;
  if (!typesFor(kind).includes(type)) {
    const allowed = typesFor(kind).join(", ");
    throw new HttpError(400, `Tilin laji ${type} ei sovi tyypille ${kind} (sallitut: ${allowed})`);
  }
};

/**
 * Name and account type only. A broker and a base currency are facts about the
 * account that its stored transactions were already interpreted under --
 * changing either after rows exist would silently reinterpret them -- so
 * neither is editable here.
 *
 * The type is editable, unlike those two, because nothing in the ledger has
 * been interpreted under it yet: it is a fact about the account's tax treatment
 * that only phase 4 reads. Getting it wrong and correcting it later must be
 * possible -- an account whose type was guessed once and then frozen is exactly
 * how a tax report ends up confidently wrong.
 */
export const UpdateAccount = z
  .object({
    name: z.string().trim().min(1, "Nimi ei voi olla tyhjä").max(100).optional(),
    accountType: accountType.nullable().optional(),
    ...terms,
  })
  .refine(
    (body) =>
      body.name !== undefined ||
      body.accountType !== undefined ||
      body.maturityDate !== undefined ||
      body.interestRate !== undefined,
    { message: "Ei muutettavia kenttiä" },
  );

export const CreateAccount = z.object({
  name: z.string().min(1).max(100),
  broker: z.enum(["nordnet", "op", "spankki", "danske", "other"]),
  baseCurrency: currencyField.default(EUR),
  kind: accountKind.default("brokerage"),
  // Optional at creation: an owner importing a broker export may not know yet
  // which of their accounts it covers. Left null until they say.
  accountType: accountType.optional(),
  ...terms,
});

/**
 * Confirms `accountId` belongs to `userId`, throwing a 404 `HttpError`
 * otherwise — the same response an account that does not exist at all
 * would produce, so a caller cannot distinguish "not yours" from
 * "does not exist". Any route that accepts an account id from the client
 * (transactions, imports, snapshots — Tasks 12, 13, 16) must call this
 * before touching that account's data; ownership is never inferred from
 * the request alone.
 */
export const assertAccountOwned = (userId: string, accountId: number): void => {
  const owned = sharedDb
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.userId, userId)))
    .get();
  if (!owned) throw new HttpError(404, "Tiliä ei löydy");
};

/** Every account this person owns. */
export const listAccounts = (db: Db, userId: string) => {
  return db.select().from(accounts).where(eq(accounts.userId, userId)).all();
};

/** Opens one, refusing a type that does not match its kind or its terms. */
export const openAccount = (db: Db, userId: string, body: z.infer<typeof CreateAccount>) => {
  assertTypeMatchesKind(body.kind, body.accountType);
  assertTermsMatchType(body.accountType, body);
  const created = db
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

/** Renames one, or changes its type and deposit terms. */
export const updateAccount = (
  db: Db,
  userId: string,
  accountId: number,
  body: z.infer<typeof UpdateAccount>,
) => {
  assertAccountOwned(userId, accountId);

  // Only the fields the request actually carried: an absent `name` must not
  // blank the stored one, and an absent type must not clear it. An explicit
  // null for the type does clear it -- "I no longer know" is a valid answer.
  // Terms are checked against the type the account will HAVE after this
  // request, not the one it had before: setting type and maturity together
  // in one PATCH is the normal way to record a new deposit.
  const current = db.select().from(accounts).where(eq(accounts.id, accountId)).get();
  // The kind is fixed at creation: an account's transactions were imported
  // and interpreted under it, and a brokerage account turned into a bank one
  // would take its holdings out of the return figures with no trace.
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

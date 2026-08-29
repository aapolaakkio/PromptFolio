import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { EUR } from "../../core/money";
import { requireUser } from "../auth-guard";
import { currencyField } from "./currency-field";
import { getDb } from "../db";
import { accounts } from "../db/schema";
import { HttpError, handle, json } from "../http";

const { db } = getDb();

const accountType = z.enum(["aot", "ost", "current", "savings", "fixed_term", "other"]);

/** Every bank account kind holds cash; only a fixed-term deposit locks it away. */
const CASH_TYPES = new Set(["current", "savings", "fixed_term"]);

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
  if ((body.interestRate ?? null) !== null && !CASH_TYPES.has(type ?? "")) {
    throw new HttpError(400, "Korko koskee vain pankkitilejä");
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
const UpdateAccount = z
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

const CreateAccount = z.object({
  name: z.string().min(1).max(100),
  broker: z.enum(["nordnet", "op", "spankki", "danske", "other"]),
  baseCurrency: currencyField.default(EUR),
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
  const owned = db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.userId, userId)))
    .get();
  if (!owned) throw new HttpError(404, "Tiliä ei löydy");
};

export const accountRoutes = {
  "/api/accounts": {
    GET: handle(async (request) => {
      const { userId } = await requireUser(request);
      return json(db.select().from(accounts).where(eq(accounts.userId, userId)).all());
    }),
    POST: handle(async (request) => {
      const { userId } = await requireUser(request);
      const body = CreateAccount.parse(await request.json());
      assertTermsMatchType(body.accountType, body);
      const created = db
        .insert(accounts)
        .values({
          name: body.name,
          broker: body.broker,
          baseCurrency: body.baseCurrency,
          accountType: body.accountType ?? null,
          maturityDate: body.maturityDate ?? null,
          interestRateBp: body.interestRate ?? null,
          userId,
        })
        .returning()
        .get();
      return json(created, 201);
    }),
  },

  "/api/accounts/:id": {
    PATCH: handle(async (request) => {
      const { userId } = await requireUser(request);
      const accountId = z.coerce
        .number()
        .int()
        .positive()
        .parse(new URL(request.url).pathname.split("/").at(-1));
      assertAccountOwned(userId, accountId);

      const body = UpdateAccount.parse(await request.json());
      // Only the fields the request actually carried: an absent `name` must not
      // blank the stored one, and an absent type must not clear it. An explicit
      // null for the type does clear it -- "I no longer know" is a valid answer.
      // Terms are checked against the type the account will HAVE after this
      // request, not the one it had before: setting type and maturity together
      // in one PATCH is the normal way to record a new deposit.
      const current = db.select().from(accounts).where(eq(accounts.id, accountId)).get();
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
      return json(
        db
          .update(accounts)
          .set(changes)
          .where(and(eq(accounts.id, accountId), eq(accounts.userId, userId)))
          .returning()
          .get(),
      );
    }),
  },
};

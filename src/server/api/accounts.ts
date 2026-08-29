import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { EUR } from "../../core/money";
import { requireUser } from "../auth-guard";
import { currencyField } from "./currency-field";
import { getDb } from "../db";
import { accounts } from "../db/schema";
import { HttpError, handle, json } from "../http";

const { db } = getDb();

const accountType = z.enum(["aot", "ost", "other"]);

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
  })
  .refine((body) => body.name !== undefined || body.accountType !== undefined, {
    message: "Ei muutettavia kenttiä",
  });

const CreateAccount = z.object({
  name: z.string().min(1).max(100),
  broker: z.enum(["nordnet", "op", "spankki", "danske", "other"]),
  baseCurrency: currencyField.default(EUR),
  // Optional at creation: an owner importing a broker export may not know yet
  // which of their accounts it covers. Left null until they say.
  accountType: accountType.optional(),
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
      const created = db
        .insert(accounts)
        .values({ ...body, userId })
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
      const named = body.name === undefined ? {} : { name: body.name };
      const typed = body.accountType === undefined ? {} : { accountType: body.accountType };
      const changes = { ...named, ...typed } satisfies Partial<typeof accounts.$inferInsert>;
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

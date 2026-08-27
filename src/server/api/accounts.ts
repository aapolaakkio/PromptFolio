import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { requireUser } from "../auth-guard";
import { getDb } from "../db";
import { accounts } from "../db/schema";
import { HttpError, handle, json } from "../http";

const { db } = getDb();

const CreateAccount = z.object({
  name: z.string().min(1).max(100),
  broker: z.enum(["nordnet", "op", "spankki", "danske", "other"]),
  baseCurrency: z.enum(["EUR", "USD"]).default("EUR"),
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
};

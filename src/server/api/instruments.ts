import { eq } from "drizzle-orm";
import { z } from "zod";
import { requireUser } from "../auth-guard";
import { getDb } from "../db";
import { instruments } from "../db/schema";
import { HttpError, handle, json } from "../http";

const { db } = getDb();

const UpsertInstrument = z.object({
  isin: z.string().regex(/^[A-Z]{2}[A-Z0-9]{9}\d$/, "ISIN-tunnus on virheellinen"),
  ticker: z.string().min(1).max(20).nullable(),
  name: z.string().min(1).max(200),
  kind: z.enum(["stock", "etf", "fund", "cash"]),
  currency: z.enum(["EUR", "USD"]),
  priceSource: z.enum([
    "yahoo",
    "nordnet_fund",
    "op_fund",
    "spankki_fund",
    "danske_fund",
    "manual",
  ]),
  sourceKey: z.string().min(1).max(200),
});

// Instruments are shared reference data across the family instance (every
// household member's transactions can reference the same Nokia share), so
// they are readable and creatable by any authenticated user; only ledger
// rows (accounts, transactions, ...) are scoped per user.
export const instrumentRoutes = {
  "/api/instruments": {
    GET: handle(async (request) => {
      await requireUser(request);
      return json(db.select().from(instruments).all());
    }),
    POST: handle(async (request) => {
      await requireUser(request);
      const body = UpsertInstrument.parse(await request.json());
      const existing = db.select().from(instruments).where(eq(instruments.isin, body.isin)).get();
      if (existing) throw new HttpError(409, `ISIN ${body.isin} on jo lisätty`);
      return json(db.insert(instruments).values(body).returning().get(), 201);
    }),
  },
};

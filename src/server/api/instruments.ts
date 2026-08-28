import { eq } from "drizzle-orm";
import { z } from "zod";
import { requireUser } from "../auth-guard";
import { currencyField } from "./currency-field";
import { getDb } from "../db";
import { instruments } from "../db/schema";
import { HttpError, handle, json } from "../http";
import { lookupInstrument } from "../instruments/lookup";

const { db } = getDb();

const UpsertInstrument = z.object({
  isin: z.string().regex(/^[A-Z]{2}[A-Z0-9]{9}\d$/, "ISIN-tunnus on virheellinen"),
  ticker: z.string().min(1).max(20).nullable(),
  name: z.string().min(1).max(200),
  kind: z.enum(["stock", "etf", "fund", "cash"]),
  currency: currencyField,
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
const LookupQuery = z.object({
  isin: z
    .string()
    .regex(/^[A-Z]{2}[A-Z0-9]{9}\d$/, "ISIN-tunnus on virheellinen")
    .nullable(),
  name: z.string().max(200),
  /**
   * The holding's own currency, from the broker rows it appeared in. It
   * decides which of a security's listings is the right price source, so it
   * is optional only for a caller that genuinely does not know it.
   */
  currency: currencyField.nullable(),
});

export const instrumentRoutes = {
  /**
   * Best-effort resolution of an unregistered holding, so the review screen
   * can pre-fill the form instead of asking the user to type what public
   * registries already know. Never creates anything, and answers with nulls
   * rather than failing when no registry recognises the security -- see
   * ../instruments/lookup.ts.
   */
  "/api/instruments/lookup": {
    GET: handle(async (request) => {
      await requireUser(request);
      const params = new URL(request.url).searchParams;
      const query = LookupQuery.parse({
        isin: params.get("isin"),
        name: params.get("name") ?? "",
        currency: params.get("currency"),
      });
      return json(await lookupInstrument(query.isin, query.name, query.currency));
    }),
  },
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

import { eq } from "drizzle-orm";
import { z } from "zod";
import { requireUser } from "../auth-guard.ts";
import { currencyField } from "./currency-field.ts";
import { getDb } from "../db/index.ts";
import { instruments } from "../db/schema.ts";
import { HttpError, handle, json } from "../http.ts";
import { lookupInstrument } from "../instruments/lookup.ts";

const { db } = getDb();

const UpsertInstrument = z
  .object({
    /**
     * Optional only for `manual`: a delisted share, or a temporary line from a
     * corporate action, has no ISIN any registry will give up, and requiring
     * one made such a holding impossible to register at all. Absent is recorded
     * as null -- never as an invented code, which is the identifier every
     * broker's rows join on.
     */
    isin: z
      .string()
      .regex(/^[A-Z]{2}[A-Z0-9]{9}\d$/, "ISIN-tunnus on virheellinen")
      .optional(),
    ticker: z.string().min(1).max(20).nullable(),
    name: z.string().min(1).max(200),
    kind: z.enum(["stock", "etf", "fund", "cash"]),
    currency: currencyField,
    priceSource: z.enum(["yahoo", "nordnet_fund", "op_fund", "manual"]),
    /**
     * Optional only for `manual`, for the same reason as `isin`: nothing can
     * price such a holding, so there is no key to fetch it by. Every fetching
     * source still requires a real key.
     */
    sourceKey: z.string().max(200).optional(),
  })
  .refine((body) => body.priceSource === "manual" || (body.sourceKey ?? "") !== "", {
    message: "Lähdetunnus vaaditaan, kun hintalähde hakee hinnat automaattisesti",
    path: ["sourceKey"],
  })
  .refine((body) => body.priceSource === "manual" || (body.isin ?? "") !== "", {
    message: "ISIN-tunnus vaaditaan, kun hintalähde hakee hinnat automaattisesti",
    path: ["isin"],
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
      const isin = body.isin ?? null;
      if (isin !== null) {
        const existing = db.select().from(instruments).where(eq(instruments.isin, isin)).get();
        if (existing) throw new HttpError(409, `ISIN ${isin} on jo lisätty`);
      } else {
        // Nothing else identifies an ISIN-less instrument, so its name has to:
        // two of them sharing one would be indistinguishable to every import
        // that resolves by name, which is the only way these are ever matched.
        const existing = db.select().from(instruments).where(eq(instruments.name, body.name)).get();
        if (existing) throw new HttpError(409, `Arvopaperi ${body.name} on jo lisätty`);
      }
      // With no ISIN there is nothing meaningful to key a fetch by; the name is
      // what every later import matches on, so it stands in.
      const sourceKey = body.sourceKey?.trim() || isin || body.name;
      return json(
        db
          .insert(instruments)
          .values({ ...body, isin, sourceKey })
          .returning()
          .get(),
        201,
      );
    }),
  },
};

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { currencyField } from "../../server/currency-field.ts";
import { db } from "../../server/db/index.ts";
import { lookupInstrument } from "../../server/instruments/lookup.ts";
import {
  addInstrument,
  listInstruments,
  updateInstrument,
} from "../../server/instruments/store.ts";
import { authed, readable } from "./guard.ts";

const Isin = z.string().regex(/^[A-Z]{2}[A-Z0-9]{9}\d$/, "ISIN-tunnus on virheellinen");

/** Every instrument the household knows: shared reference data, not ledger rows. */
export const getInstruments = createServerFn()
  .middleware([authed])
  .handler(() => listInstruments(db));

/** Asks the price sources what a security is, before anyone registers it. */
export const lookUpInstrument = createServerFn()
  .middleware([authed])
  .validator(
    z.object({
      isin: Isin.nullable(),
      name: z.string().max(200),
      currency: currencyField.nullable(),
    }),
  )
  .handler(({ data }) => readable(() => lookupInstrument(data.isin, data.name, data.currency)));

/** Registers one, refusing a duplicate by ISIN, or by name when it has none. */
export const createInstrument = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(
    z
      .object({
        // Optional only for `manual`: a delisted share, or a temporary line
        // from a corporate action, has no ISIN any registry will give up.
        isin: Isin.optional(),
        ticker: z.string().min(1).max(20).nullable(),
        name: z.string().min(1).max(200),
        kind: z.enum(["stock", "etf", "fund", "cash"]),
        currency: currencyField,
        priceSource: z.enum(["yahoo", "nordnet_fund", "op_fund", "manual"]),
        sourceKey: z.string().max(200).optional(),
      })
      .refine((body) => body.priceSource === "manual" || (body.sourceKey ?? "") !== "", {
        message: "Lähdetunnus vaaditaan, kun hintalähde hakee hinnat automaattisesti",
        path: ["sourceKey"],
      })
      .refine((body) => body.priceSource === "manual" || (body.isin ?? "") !== "", {
        message: "ISIN-tunnus vaaditaan, kun hintalähde hakee hinnat automaattisesti",
        path: ["isin"],
      }),
  )
  .handler(({ data }) => readable(() => addInstrument(db, data)));

/** Corrects an instrument's currency, price source or source code. */
export const editInstrument = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(
    z.object({
      id: z.number().int().positive(),
      currency: currencyField,
      priceSource: z.enum(["yahoo", "nordnet_fund", "op_fund", "manual"]),
      sourceKey: z.string().max(200),
    }),
  )
  .handler(({ data }) => readable(() => updateInstrument(db, data.id, data)));

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { currencyField } from "../../server/currency-field.ts";
import { db } from "../../server/db/index.ts";
import type { InstrumentLookup } from "../../server/instruments/lookup.ts";
import { rememberedLookup } from "../../server/instruments/lookup-cache.ts";
import { createClient } from "../../server/chat/runner.ts";
import {
  addInstrument,
  addPageInstrument,
  listInstruments,
  updateInstrument,
  updatePageInstrument,
  type PageDeps,
} from "../../server/instruments/store.ts";
import type { FetchedPrice } from "../../server/prices/types.ts";
import { authed, readable } from "./guard.ts";

/** The model client is made only for a page, so the other sources work without a key. */
const pageDeps = (): PageDeps => ({
  fetchImpl: fetch,
  client: createClient(),
  today: new Date().toISOString().slice(0, 10),
});

/** What saving told the form: the price a page was read for, null for any other source. */
export type SaveResult = { readonly price: FetchedPrice | null };

const MAX_SOURCE_KEY = 200;
const MAX_PAGE_URL = 2000;
const tooLongKey = (priceSource: string, sourceKey: string | undefined): boolean =>
  (sourceKey ?? "").length > (priceSource === "page" ? MAX_PAGE_URL : MAX_SOURCE_KEY);
const KEY_TOO_LONG = "Lähdetunnus on liian pitkä";

const Isin = z.string().regex(/^[A-Z]{2}[A-Z0-9]{9}\d$/, "ISIN-tunnus on virheellinen");

/** Every instrument the household knows: shared reference data, not ledger rows. */
export const getInstruments = createServerFn()
  .middleware([authed])
  .handler(() => listInstruments(db));

/**
 * A page result an import remembered prefills the form like any other source;
 * the recipe stays behind, since saving checks the page again.
 */
const forTheForm = (result: InstrumentLookup): InstrumentLookup => ({
  ...result,
  pageRecipe: null,
});

/** Asks the price sources what a security is, before anyone registers it: gated and remembered. */
export const lookUpInstrument = createServerFn()
  .middleware([authed])
  .validator(
    z.object({
      isin: Isin.nullable(),
      name: z.string().max(200),
      currency: currencyField.nullable(),
    }),
  )
  .handler(({ data }) =>
    readable(async () =>
      forTheForm(await rememberedLookup(db, data.isin, data.name, data.currency, fetch)),
    ),
  );

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
        priceSource: z.enum(["yahoo", "nordnet_fund", "op_fund", "page", "manual"]),
        sourceKey: z.string().max(MAX_PAGE_URL).optional(),
      })
      .refine((body) => !tooLongKey(body.priceSource, body.sourceKey), {
        message: KEY_TOO_LONG,
        path: ["sourceKey"],
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
  .handler(({ data }) =>
    readable(async (): Promise<SaveResult> => {
      if (data.priceSource !== "page") {
        await addInstrument(db, data);
        return { price: null };
      }
      const saved = await addPageInstrument(db, data, pageDeps());
      return { price: saved.price };
    }),
  );

/** Corrects an instrument's currency, price source or source code. */
export const editInstrument = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(
    z
      .object({
        id: z.number().int().positive(),
        currency: currencyField,
        priceSource: z.enum(["yahoo", "nordnet_fund", "op_fund", "page", "manual"]),
        sourceKey: z.string().max(MAX_PAGE_URL),
      })
      .refine((body) => !tooLongKey(body.priceSource, body.sourceKey), {
        message: KEY_TOO_LONG,
        path: ["sourceKey"],
      }),
  )
  .handler(({ data }) =>
    readable(async (): Promise<SaveResult> => {
      if (data.priceSource !== "page") {
        await updateInstrument(db, data.id, data);
        return { price: null };
      }
      const saved = await updatePageInstrument(db, data.id, data, pageDeps());
      return { price: saved.price };
    }),
  );

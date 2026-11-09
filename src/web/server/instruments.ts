import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { currencyField } from "../../server/currency-field.ts";
import { db } from "../../server/db/index.ts";
import type { InstrumentLookup } from "../../server/instruments/lookup.ts";
import { rememberedLookup } from "../../server/instruments/lookup-cache.ts";
import { parseChargePercent, setOwnCharge } from "../../server/instruments/costs.ts";
import { HttpError } from "../../server/errors.ts";
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
type SaveResult = { readonly price: FetchedPrice | null };

const MAX_SOURCE_KEY = 200;
const MAX_PAGE_URL = 2000;
const tooLongKey = (priceSource: string, sourceKey: string | undefined): boolean =>
  (sourceKey ?? "").length > (priceSource === "page" ? MAX_PAGE_URL : MAX_SOURCE_KEY);
const KEY_TOO_LONG = "Source code is too long";

const Isin = z.string().regex(/^[A-Z]{2}[A-Z0-9]{9}\d$/, "ISIN is invalid");

/** Every instrument the household knows: shared reference data, not ledger rows. */
export const getInstruments = createServerFn()
  .middleware([authed])
  .handler(() => listInstruments(db));

/** A remembered page result prefills the form; the recipe stays behind since saving re-checks the page. */
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
        // Optional only for `manual`: a delisted share has no ISIN any registry gives.
        isin: Isin.optional(),
        ticker: z.string().min(1).max(20).nullable(),
        name: z.string().min(1).max(200),
        kind: z.enum(["stock", "etf", "fund", "cash"]),
        currency: currencyField,
        priceSource: z.enum(["yahoo", "page", "manual"]),
        sourceKey: z.string().max(MAX_PAGE_URL).optional(),
      })
      .refine((body) => !tooLongKey(body.priceSource, body.sourceKey), {
        message: KEY_TOO_LONG,
        path: ["sourceKey"],
      })
      .refine((body) => body.priceSource === "manual" || (body.sourceKey ?? "") !== "", {
        message: "Source code is required when the price source fetches prices automatically",
        path: ["sourceKey"],
      })
      .refine((body) => body.priceSource === "manual" || (body.isin ?? "") !== "", {
        message: "ISIN is required when the price source fetches prices automatically",
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
        priceSource: z.enum(["yahoo", "page", "manual"]),
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

/** The owner's own ongoing charge in percent ("0,20"); empty clears it so a lookup may fill it again. */
export const setFundCharge = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(z.object({ id: z.number().int().positive(), percent: z.string().max(20) }))
  .handler(({ data }) =>
    readable(async () => {
      const text = data.percent.trim();
      const bp = text === "" ? null : parseChargePercent(text);
      if (text !== "" && bp === null) {
        throw new HttpError(400, "The fee must be a percentage from 0 to 5, for example 0.20");
      }
      await setOwnCharge(db, data.id, bp, Date.now());
    }),
  );

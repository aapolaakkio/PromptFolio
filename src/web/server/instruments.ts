import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import {
  FundChargeInput,
  InstrumentCreate,
  InstrumentEdit,
  Isin,
} from "../../server/action-inputs.ts";
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
  .validator(InstrumentCreate)
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
  .validator(InstrumentEdit)
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
  .validator(FundChargeInput)
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

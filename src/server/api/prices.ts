import { eq } from "drizzle-orm";
import { z } from "zod";
import { parseCurrency, parseMoney } from "../../core/money";
import { requireUser } from "../auth-guard";
import { getDb } from "../db";
import { instruments } from "../db/schema";
import { HttpError, handle, json } from "../http";
import { requirePositiveMinor } from "../prices/types";
import { writePrices } from "../prices/write";

const { db } = getDb();

/**
 * The one route that lets a human record a price by hand. Two Phase 1
 * deliverables depend on it and, until this task, neither had it: `manual`
 * (spec §6/§10a A5) is selectable as a price source but had no way to ever
 * write a price, and the README's documented `spankki_fund`/`danske_fund`
 * workaround ("add the instrument manually and set its price source to
 * `manual` -- you enter its NAV/price by hand") did not actually work.
 *
 * Works for ANY instrument, not only one whose own `priceSource` is
 * `manual` -- a human correcting a stale/wrong stored price for an
 * otherwise auto-fetched instrument (a `yahoo` glitch, a `nordnet_fund`
 * page that briefly served a stale NAV) needs the exact same override,
 * not a second, differently-shaped one. Every write is tagged with source
 * `"manual"` in `prices.source` regardless of the instrument's own
 * `priceSource`, so it is always visible afterwards which points came
 * from a human versus a scraper.
 *
 * `instrumentId` is accepted from the client body and used directly, with
 * no `assertAccountOwned`-style ownership check: instruments are shared
 * reference data across the whole family instance, exactly like
 * `instruments.ts`'s own POST route (readable and creatable by any
 * authenticated user, never scoped per user) -- see that file's own
 * comment for the reasoning this route reuses unchanged.
 */
const RecordPrice = z.object({
  instrumentId: z.number().int().positive(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Päivämäärän on oltava muodossa VVVV-KK-PP"),
  // A decimal string, never a JSON number: money crossing the API boundary
  // is always text (spec §9.2), and a human-typed price doubly so -- it is
  // untrusted input that must go through core/money's own parser
  // (parseMoney, below), never Number().
  price: z.string().min(1, "Hinta puuttuu").max(30, "Hinta on liian pitkä"),
});

export const priceRoutes = {
  "/api/prices": {
    POST: handle(async (request) => {
      await requireUser(request);
      const body = RecordPrice.parse(await request.json());

      const instrument = db
        .select()
        .from(instruments)
        .where(eq(instruments.id, body.instrumentId))
        .get();
      if (!instrument) throw new HttpError(404, "Arvopaperia ei löydy");

      // instruments.currency carries a free, unvalidated `.$type<Currency>()`
      // cast (see valuation.ts's `asMoney` comment for the same concern) --
      // re-validated for real here rather than trusted.
      const currency = parseCurrency(instrument.currency);

      let minor: bigint;
      try {
        minor = parseMoney(body.price, currency).minor;
      } catch {
        throw new HttpError(400, "Hinta ei ole kelvollinen desimaaliluku");
      }

      let closeMinor: number;
      try {
        closeMinor = requirePositiveMinor(Number(minor), "käsin syötetty hinta");
      } catch (cause) {
        throw new HttpError(400, cause instanceof Error ? cause.message : "Hinta on virheellinen");
      }

      // skipPlausibilityCheck: true -- see write.ts's `acceptUnconditionally`
      // doc comment for why a human-entered correction must bypass the
      // scraper-plumbing plausibility guard and its multi-day re-baseline
      // streak, rather than risk a legitimate fix being silently (or
      // repeatedly) rejected.
      const outcome = writePrices(
        db,
        instrument.id,
        "manual",
        [{ date: body.date, closeMinor, currency }],
        { skipPlausibilityCheck: true },
      );

      return json({ written: outcome.written }, 201);
    }),
  },
};

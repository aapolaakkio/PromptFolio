import { z } from "zod";
import { allocateBy } from "../../core/allocation";
import { externalCashFlows } from "../../core/ledger";
import { formatMoney, negateMoney } from "../../core/money";
import { twr, valueSeries, xirr } from "../../core/returns";
import type { IsoDate } from "../../core/types";
import { requireUser } from "../auth-guard";
import { getDb } from "../db";
import { HttpError, handle, json } from "../http";
import { holdingsFor, loadPortfolio } from "../valuation";

const { db } = getDb();

const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Päivämäärän on oltava muodossa VVVV-KK-PP");

const today = (): IsoDate => new Date().toISOString().slice(0, 10);

type DateRange = { readonly from: IsoDate; readonly to: IsoDate };

/**
 * Resolves and validates `from`/`to` query parameters, defaulting `from` to
 * a date early enough to cover this app's entire realistic history (§10a:
 * real transaction history goes back years, never further than this) and
 * `to` to today. Rejects an inverted range with a client-facing 400 rather
 * than silently handing `core` an empty or nonsensical window.
 */
const parseRange = (url: URL): DateRange => {
  const from = IsoDateSchema.parse(url.searchParams.get("from") ?? "2015-01-01");
  const to = IsoDateSchema.parse(url.searchParams.get("to") ?? today());
  if (from > to) throw new HttpError(400, "'from' on oltava ennen tai sama kuin 'to'");
  return { from, to };
};

const DimensionSchema = z.enum(["kind", "currency", "account", "instrument"]);

export const portfolioRoutes = {
  "/api/holdings": {
    GET: handle(async (request) => {
      const { userId } = await requireUser(request);
      const on = IsoDateSchema.parse(new URL(request.url).searchParams.get("on") ?? today());
      return json(holdingsFor(db, userId, on));
    }),
  },

  "/api/value-series": {
    GET: handle(async (request) => {
      const { userId } = await requireUser(request);
      const { from, to } = parseRange(new URL(request.url));
      const { txns, instruments, prices } = loadPortfolio(db, userId);
      return json(
        valueSeries(txns, instruments, prices, from, to).map((point) => ({
          date: point.date,
          valueEur: formatMoney(point.valueEur),
          stale: point.stale,
        })),
      );
    }),
  },

  "/api/allocation": {
    GET: handle(async (request) => {
      const { userId } = await requireUser(request);
      const url = new URL(request.url);
      const dimension = DimensionSchema.parse(url.searchParams.get("by") ?? "kind");
      const on = IsoDateSchema.parse(url.searchParams.get("on") ?? today());
      const { txns, instruments, prices } = loadPortfolio(db, userId);
      return json(
        allocateBy(txns, instruments, prices, on, dimension).map((slice) => ({
          key: slice.key,
          label: slice.label,
          valueEur: formatMoney(slice.valueEur),
          weight: slice.weight,
        })),
      );
    }),
  },

  "/api/returns": {
    GET: handle(async (request) => {
      const { userId } = await requireUser(request);
      const { from, to } = parseRange(new URL(request.url));
      const { txns, instruments, prices } = loadPortfolio(db, userId);
      const series = valueSeries(txns, instruments, prices, from, to);
      const flows = externalCashFlows(txns).filter((flow) => flow.date >= from && flow.date <= to);
      const final = series.at(-1);

      // core/returns.ts's xirr() takes contributions as NEGATIVE and
      // withdrawals as POSITIVE. externalCashFlows() carries the ledger's
      // own sign instead (a DEPOSIT is a positive amount -- money added to
      // the account; a WITHDRAWAL is negative), so every flow is negated
      // here to cross into xirr's convention. `negateMoney` (not a
      // format/parse round-trip) so a negative WITHDRAWAL amount does not
      // turn into an unparsable double-negative string.
      let mwr: number | null = null;
      try {
        mwr = final
          ? xirr(
              flows.map((flow) => ({ date: flow.date, amountEur: negateMoney(flow.amountEur) })),
              { date: final.date, amountEur: final.valueEur },
            )
          : null;
      } catch {
        // xirr() throws when it has fewer than two cash flows, when every
        // flow shares one sign (e.g. deposits with nothing yet invested, so
        // the tracked position value stays zero), or when neither Newton's
        // method nor its bisection fallback converges. In every case the
        // honest answer is "unknown", not a fabricated rate -- the UI shows
        // "—" for `null`, which is distinguishable from a genuine 0 return.
        mwr = null;
      }

      return json({
        from,
        to,
        valueEur: final ? formatMoney(final.valueEur) : "0.00",
        stale: final?.stale ?? false,
        twr: twr(series, flows),
        mwr,
      });
    }),
  },
};

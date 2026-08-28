import { z } from "zod";
import { allocateBy } from "../../core/allocation";
import { externalCashFlows, investedCashFlows, negativePositionIds } from "../../core/ledger";
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

const DAY_MS = 86_400_000;

/** The calendar day immediately before `date`, as an IsoDate. */
const dayBefore = (date: IsoDate): IsoDate =>
  new Date(Date.parse(date) - DAY_MS).toISOString().slice(0, 10);

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
          // Instruments excluded from this day's valueEur because their net
          // position was negative (an unmatched disposal -- see core/ledger.ts's
          // negativePositionIds). Cross-reference against /api/holdings, which
          // carries each instrument's ISIN, name and Finnish explanation.
          excludedInstrumentIds: point.excludedInstrumentIds,
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
      const byId = new Map(instruments.map((instrument) => [instrument.id, instrument]));

      const { slices, excludedInstrumentIds } = allocateBy(
        txns,
        instruments,
        prices,
        on,
        dimension,
      );

      // Two distinct reasons a holding can be left out of every slice, both of which
      // must be visible rather than a silent gap (C1): allocateBy() itself already
      // excludes an instrument it could not price/convert (`excludedInstrumentIds`,
      // computed per-account -- see its own doc for why negative positions are
      // deliberately not in that list), and a negative (unmatched-disposal) position
      // is reported by ledger.ts's whole-ledger negativePositionIds() instead. Merged
      // here (deduped by instrumentId) into one list, each entry enriched with the
      // ISIN/name a caller needs to act on it (the same instrumentId /api/holdings
      // reports the same instrument's costBasisError under).
      const excludedIds = new Set([...negativePositionIds(txns, on), ...excludedInstrumentIds]);
      const excludedInstruments = [...excludedIds].flatMap((instrumentId) => {
        const instrument = byId.get(instrumentId);
        return instrument ? [{ instrumentId, isin: instrument.isin, name: instrument.name }] : [];
      });

      return json({
        slices: slices.map((slice) => ({
          key: slice.key,
          label: slice.label,
          valueEur: formatMoney(slice.valueEur),
          weight: slice.weight,
        })),
        excludedInstruments,
      });
    }),
  },

  "/api/returns": {
    GET: handle(async (request) => {
      const { userId } = await requireUser(request);
      const { from, to } = parseRange(new URL(request.url));
      const { txns, instruments, prices } = loadPortfolio(db, userId);
      const byId = new Map(instruments.map((instrument) => [instrument.id, instrument]));
      const series = valueSeries(txns, instruments, prices, from, to);
      // mwrFlows (deposit/withdrawal-shaped) feeds xirr() below, which measures the
      // investor's own money-weighted experience -- it legitimately cares about when
      // *they* moved cash. twrFlows (BUY/SELL-shaped) feeds twr() -- see that
      // function's doc and `investedCashFlows`'s doc in core/ledger.ts for why the two
      // must NOT be the same list: `series` prices invested positions only (spec §7),
      // so the flow describing money entering it is a purchase, not a deposit.
      const mwrFlows = externalCashFlows(txns).filter(
        (flow) => flow.date >= from && flow.date <= to,
      );
      const twrFlows = investedCashFlows(txns).filter(
        (flow) => flow.date >= from && flow.date <= to,
      );
      const final = series.at(-1);

      // MWR over an arbitrary [from, to] window must account for whatever
      // the portfolio was already worth going into `from` -- otherwise
      // xirr() sees the final value as having appeared from nothing and
      // returns a finite, plausible, WRONG rate instead of failing loudly.
      // Standard treatment: the value at the start of the window becomes
      // an implicit contribution dated `from`.
      //
      // That value is looked up as of the day BEFORE `from`, not `from`
      // itself (nor reused from `series[0]`, which already reflects any
      // trade dated exactly `from`). This is what keeps the adjustment a
      // genuine no-op for the common since-inception default range: when
      // nothing predates `from` (e.g. the account's very first deposit and
      // buy are both dated `from`), the day-before value is exactly zero,
      // so the implicit contribution contributes nothing -- the deposit
      // dated `from` is still counted exactly once, via the ordinary
      // `mwrFlows` list below, not doubled here too. `noUncheckedIndexedAccess`
      // types `[0]` as possibly undefined even though a same-day range
      // always yields exactly one point; the `opening ? ... : []` below
      // handles that without an assertion.
      const opening = valueSeries(txns, instruments, prices, dayBefore(from), dayBefore(from))[0];

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
              [
                ...(opening ? [{ date: from, amountEur: negateMoney(opening.valueEur) }] : []),
                ...mwrFlows.map((flow) => ({
                  date: flow.date,
                  amountEur: negateMoney(flow.amountEur),
                })),
              ],
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

      // C5: every instrument excluded from `valueEur` on ANY day inside [from, to] --
      // not just `final`'s day -- because `twr` (spec §7) is a function of the whole
      // series, not just its last point: a holding unpriceable for a stretch in the
      // middle of the window can drive `twr` to `null` (see that function's doc) even
      // when the final day's own value is complete. Deduped and enriched with
      // isin/name the same way `/api/allocation`'s `excludedInstruments` already is,
      // so the dashboard can name the holding instead of showing a bare id.
      const excludedIds = new Set(series.flatMap((point) => point.excludedInstrumentIds));
      const excludedInstruments = [...excludedIds].flatMap((instrumentId) => {
        const instrument = byId.get(instrumentId);
        return instrument ? [{ instrumentId, isin: instrument.isin, name: instrument.name }] : [];
      });

      return json({
        from,
        to,
        valueEur: final ? formatMoney(final.valueEur) : "0.00",
        stale: final?.stale ?? false,
        twr: twr(series, twrFlows),
        mwr,
        excludedInstruments,
      });
    }),
  },
};

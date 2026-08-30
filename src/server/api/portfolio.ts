import { eq } from "drizzle-orm";
import { z } from "zod";
import { allocateBy } from "../../core/allocation";
import {
  accountsMissingCashRecord,
  fundingCashFlows,
  investedCashFlows,
  negativePositionIds,
} from "../../core/ledger";
import { addMoney, EUR, formatMoney, negateMoney, zeroMoney } from "../../core/money";
import { investedSeries, twr, valueSeries, xirr } from "../../core/returns";
import type { IsoDate, Txn } from "../../core/types";
import { requireUser } from "../auth-guard";
import { getDb } from "../db";
import { accounts } from "../db/schema";
import { HttpError, handle, json } from "../http";
import { cashFor, holdingsFor, loadPortfolio, withAvailability } from "../valuation";
import {
  availableCashEur,
  cashBalancesAt,
  lockedCashEur,
  totalCashEur,
  valueCash,
} from "../../core/cash";
import { cashFlowFor } from "../spending/cashflow";
import { investmentPaymentIds } from "../spending/internal";
import { CATEGORY_LABELS } from "../spending/categories";
import { monthlyByCategory, monthlyFlows } from "../spending/monthly";
import { addRules, categoriseWith, removeRule, rulesFor } from "../spending/rules";
import { summariseSpending } from "../spending/summary";

const { db } = getDb();

/**
 * Payment labels, as opposed to payees. When the statement carried no payee the
 * grouping falls back to one of these, and a rule written on it would catch
 * every payment of that kind rather than the one shop in front of the reader.
 */
const LABEL_ONLY: ReadonlySet<string> = new Set([
  "PKORTTIMAKSU",
  "MAKSUPALVELU",
  "TILISIIRTO",
  "PANO",
  "OTTO",
  "PALKKA",
  "LUOTON MAKSU",
  "TALLETUSKORKO",
  "PERUUTUS",
  "ETUUS",
  "NIMETÖN",
]);

/**
 * Invested accounts whose own export never records cash arriving -- OP's
 * securities view is one. Their purchases stand in for the deposits that fund
 * them, which is how a regular fund saving is recognised as investing rather
 * than spending.
 */
const cashlessAccountIds = (
  txns: readonly Txn[],
  bankAccountIds: ReadonlySet<number>,
): ReadonlySet<number> =>
  new Set(accountsMissingCashRecord(txns).filter((accountId) => !bankAccountIds.has(accountId)));

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

  "/api/cashflow": {
    GET: handle(async (request) => {
      const { userId } = await requireUser(request);
      const url = new URL(request.url);
      const from = IsoDateSchema.parse(url.searchParams.get("from") ?? "1900-01-01");
      const to = IsoDateSchema.parse(url.searchParams.get("to") ?? today());

      const { txns, bankAccountIds } = loadPortfolio(db, userId);
      const bank = new Set(bankAccountIds);
      // Every account that is not a bank one holds investments, and its own
      // deposits are the reliable record of money moved into it.
      const invested = new Set(
        txns.map((txn) => txn.accountId).filter((accountId) => !bank.has(accountId)),
      );

      return json(
        cashFlowFor({
          txns,
          rules: rulesFor(db, userId),
          bankAccountIds: bank,
          investedAccountIds: invested,
          cashlessInvestedAccountIds: cashlessAccountIds(txns, bank),
          from,
          to,
        }),
      );
    }),
  },

  "/api/spending/monthly": {
    GET: handle(async (request) => {
      const { userId } = await requireUser(request);
      const url = new URL(request.url);
      const from = IsoDateSchema.parse(url.searchParams.get("from") ?? "1900-01-01");
      const to = IsoDateSchema.parse(url.searchParams.get("to") ?? today());

      const { txns, bankAccountIds } = loadPortfolio(db, userId);
      const shared = {
        txns,
        rules: rulesFor(db, userId),
        bankAccountIds: new Set(bankAccountIds),
        from,
        to,
      };
      return json({
        months: monthlyFlows(shared),
        // The same months split by category, for the chart that shows whether
        // one is creeping upward -- which a single period's Sankey cannot say.
        byCategory: monthlyByCategory({
          ...shared,
          // SAFETY: the key comes from `categoriseWith`, which only ever
          // returns a `Category` -- exactly the keys `CATEGORY_LABELS` is
          // declared over. The fallback covers a rule stored before a category
          // was renamed, which shows the raw key rather than nothing.
          labelFor: (category) =>
            CATEGORY_LABELS[category as keyof typeof CATEGORY_LABELS] ?? category,
        }),
      });
    }),
  },

  "/api/spending/uncategorised": {
    GET: handle(async (request) => {
      const { userId } = await requireUser(request);
      const url = new URL(request.url);
      const from = IsoDateSchema.parse(url.searchParams.get("from") ?? "1900-01-01");
      const to = IsoDateSchema.parse(url.searchParams.get("to") ?? today());

      const { txns, bankAccountIds } = loadPortfolio(db, userId);
      const bank = new Set(bankAccountIds);
      const invested = investmentPaymentIds(txns, cashlessAccountIds(txns, bank), bank);
      const rules = rulesFor(db, userId);

      // Only what no rule matched: this is the list a person works through to
      // teach the app, so anything already classified is noise in it.
      const unmatched = txns.filter(
        (txn) =>
          bank.has(txn.accountId) &&
          !invested.has(txn.id) &&
          categoriseWith(txn.note ?? "", rules) === "muu",
      );

      const summary = summariseSpending(unmatched, { from, to, by: "counterparty", rules });
      return json({
        from,
        to,
        totalEur: summary.totalEur,
        merchants: summary.groups.map((group) => ({
          name: group.label,
          totalEur: group.totalEur,
          count: group.count,
          // A row whose payee the statement never carried is grouped under its
          // own label ("MAKSUPALVELU"). A rule on that would file every bill
          // payment the same way, so the screen must not offer it as one.
          payeeKnown: !LABEL_ONLY.has(group.label.toUpperCase()),
        })),
        categories: Object.entries(CATEGORY_LABELS).map(([id, label]) => ({ id, label })),
      });
    }),
  },

  "/api/spending/rules": {
    GET: handle(async (request) => {
      const { userId } = await requireUser(request);
      return json({
        rules: rulesFor(db, userId),
        categories: Object.entries(CATEGORY_LABELS).map(([id, label]) => ({ id, label })),
      });
    }),

    POST: handle(async (request) => {
      const { userId } = await requireUser(request);
      const body = z
        .object({
          rules: z
            .array(z.object({ pattern: z.string().trim().min(3).max(60), category: z.string() }))
            .min(1)
            .max(50),
        })
        .strict()
        .parse(await request.json());

      // Entered by a person, so recorded as theirs: a rule the assistant
      // guessed and one its owner wrote are different claims (see schema.ts).
      const { added, rejected } = addRules(db, userId, body.rules, "user");
      return json({ added, rejected }, 201);
    }),

    DELETE: handle(async (request) => {
      const { userId } = await requireUser(request);
      const pattern = new URL(request.url).searchParams.get("pattern") ?? "";
      if (!removeRule(db, userId, pattern)) throw new HttpError(404, "Sääntöä ei löydy");
      return json({ ok: true });
    }),
  },

  "/api/spending": {
    GET: handle(async (request) => {
      const { userId } = await requireUser(request);
      const url = new URL(request.url);
      const from = IsoDateSchema.parse(url.searchParams.get("from") ?? "1900-01-01");
      const to = IsoDateSchema.parse(url.searchParams.get("to") ?? today());
      const by = z
        .enum(["category", "counterparty"])
        .parse(url.searchParams.get("by") ?? "category");
      const limit = z.coerce
        .number()
        .int()
        .min(1)
        .max(50)
        .parse(url.searchParams.get("limit") ?? "15");

      // Bank rows only -- see summariseSpending's own note on why a purchase is
      // not spending.
      const { txns, bankAccountIds } = loadPortfolio(db, userId);
      const bank = new Set(bankAccountIds);
      // A payment that funded a fund purchase is investing, not spending, and
      // would otherwise sit among the shops as one of the year's largest lines.
      const invested = investmentPaymentIds(txns, cashlessAccountIds(txns, bank), bank);
      return json(
        summariseSpending(
          txns.filter((txn) => bank.has(txn.accountId) && !invested.has(txn.id)),
          { from, to, by, limit, rules: rulesFor(db, userId) },
        ),
      );
    }),
  },

  "/api/cash": {
    GET: handle(async (request) => {
      const { userId } = await requireUser(request);
      const on = IsoDateSchema.parse(new URL(request.url).searchParams.get("on") ?? today());
      return json(cashFor(db, userId, on));
    }),
  },

  "/api/value-series": {
    GET: handle(async (request) => {
      const { userId } = await requireUser(request);
      const { from, to } = parseRange(new URL(request.url));
      const { investedTxns, instruments, prices } = loadPortfolio(db, userId);
      // Both series are one point per calendar day over the same range, so the
      // two line up index for index and the chart can draw them together
      // without matching dates itself.
      const invested = investedSeries(investedTxns, from, to);
      return json(
        valueSeries(investedTxns, instruments, prices, from, to).map((point, index) => ({
          date: point.date,
          valueEur: formatMoney(point.valueEur),
          investedEur: formatMoney(invested[index]?.investedEur ?? zeroMoney(EUR)),
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

      // Cash is part of the allocation (spec 10c/C2): a portfolio holding a
      // fifth of its value in an unspent deposit is not 100 % invested, and a
      // pie chart that says so is wrong.
      const cash = withAvailability(
        db,
        userId,
        valueCash(cashBalancesAt(txns, on), prices.fxOn, on),
        on,
      );
      const { slices, excludedInstrumentIds } = allocateBy(
        txns,
        instruments,
        prices,
        on,
        dimension,
        cash,
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
      const { txns, investedTxns, instruments, prices } = loadPortfolio(db, userId);
      const byId = new Map(instruments.map((instrument) => [instrument.id, instrument]));
      // Invested transactions only: a bank account's rows are spending and
      // salary, and DEPOSIT/WITHDRAWAL feed XIRR as external flows, so leaving
      // them in would report every grocery payment as capital withdrawn.
      const series = valueSeries(investedTxns, instruments, prices, from, to);
      // mwrFlows (deposit/withdrawal-shaped) feeds xirr() below, which measures the
      // investor's own money-weighted experience -- it legitimately cares about when
      // *they* moved cash. twrFlows (BUY/SELL-shaped) feeds twr() -- see that
      // function's doc and `investedCashFlows`'s doc in core/ledger.ts for why the two
      // must NOT be the same list: `series` prices invested positions only (spec §7),
      // so the flow describing money entering it is a purchase, not a deposit.
      // Chosen per account from whichever record that account keeps: deposits
      // where a broker reports cash, purchases where it reports none. See
      // fundingCashFlows -- measuring OP's holdings against Nordnet's deposits
      // alone reported roughly three times the true annual rate.
      const mwrFlows = fundingCashFlows(investedTxns).filter(
        (flow) => flow.date >= from && flow.date <= to,
      );
      const twrFlows = investedCashFlows(investedTxns).filter(
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
      const opening = valueSeries(
        investedTxns,
        instruments,
        prices,
        dayBefore(from),
        dayBefore(from),
      )[0];

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
      const ownedAccounts = new Map(
        db
          .select({ id: accounts.id, name: accounts.name })
          .from(accounts)
          .where(eq(accounts.userId, userId))
          .all()
          .map((row) => [row.id, row.name] as const),
      );

      const excludedIds = new Set(series.flatMap((point) => point.excludedInstrumentIds));
      const excludedInstruments = [...excludedIds].flatMap((instrumentId) => {
        const instrument = byId.get(instrumentId);
        return instrument ? [{ instrumentId, isin: instrument.isin, name: instrument.name }] : [];
      });

      // Cash on the window's last day, and the total that includes it. Both are
      // computed here rather than added up in the browser: the client never does
      // money arithmetic, and there must be exactly one definition of "what the
      // portfolio is worth" for the dashboard and the chat to agree on.
      //
      // `twr`/`mwr` below deliberately stay position-only (spec 7, confirmed
      // 10c/C2): an account holding an unspent deposit has a lower total value
      // but has not performed worse, and folding cash into the return would say
      // it had.
      const cashAtEnd = withAvailability(
        db,
        userId,
        valueCash(cashBalancesAt(txns, to), prices.fxOn, to),
        to,
      );
      const cashEur = totalCashEur(cashAtEnd);
      const positionsEur = final ? final.valueEur : zeroMoney(EUR);

      return json({
        from,
        to,
        valueEur: formatMoney(positionsEur),
        cashEur: formatMoney(cashEur),
        // What of that cash could actually be spent on the day, and what is tied
        // up in a deposit until it matures.
        availableCashEur: formatMoney(availableCashEur(cashAtEnd)),
        lockedCashEur: formatMoney(lockedCashEur(cashAtEnd)),
        valueWithCashEur: formatMoney(addMoney(positionsEur, cashEur)),
        stale: final?.stale ?? false,
        twr: twr(series, twrFlows),
        mwr,
        excludedInstruments,
        /**
         * Accounts whose broker exports no cash movements at all, so their
         * contributions are inferred from purchases. Named here rather than
         * left implicit: the money-weighted figure means something slightly
         * different for them, and silently picking a definition is what
         * produced a confidently wrong number before.
         */
        accountsMissingCashRecord: accountsMissingCashRecord(investedTxns).flatMap((accountId) => {
          const account = ownedAccounts.get(accountId);
          return account ? [{ accountId, name: account }] : [];
        }),
      });
    }),
  },
};

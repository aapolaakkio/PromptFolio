import { z } from "zod";

import { allocateBy, type Dimension } from "../../core/allocation";
import { fundingCashFlows, investedCashFlows } from "../../core/ledger";
import { formatMoney, formatQuantity, negateMoney } from "../../core/money";
import { twr, valueSeries, xirr } from "../../core/returns";
import type { IsoDate } from "../../core/types";
import type { getDb } from "../db";
import { cashFor, holdingsFor, loadPortfolio } from "../valuation";

type Db = ReturnType<typeof getDb>["db"];

const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Päivämäärän on oltava muotoa YYYY-MM-DD");

const today = (): IsoDate => new Date().toISOString().slice(0, 10);

/**
 * How much of the ledger one tool call may hand the model.
 *
 * Both are token budgets, not display limits: a tool result stays in the
 * conversation and is re-sent with every later turn, so an over-generous
 * default is paid for again and again. Each tool says when it truncated, and
 * `limit` lets the model ask for more when a question needs it.
 */
const MAX_SERIES_POINTS = 60;
const DEFAULT_TXN_LIMIT = 25;

/**
 * The read-only tools the chat model may call (spec §8).
 *
 * Every one is a thin wrapper over the same `core` function the dashboard calls,
 * so chat and screen cannot disagree about a number. None of them writes, none
 * takes a user id from the model -- the caller binds that from the session, so a
 * question can never reach another household member's ledger however it is
 * phrased.
 *
 * Each result carries the date it was computed for and whether any part of it is
 * stale, because the model is instructed to state both and can only do that if
 * the tool tells it. Money and quantities cross as decimal strings, the same
 * wire rule the HTTP API follows: a model that receives a float is one rounding
 * away from quoting a number the ledger never held.
 */
export type ChatTool = {
  readonly name: string;
  readonly description: string;
  readonly schema: z.ZodType<ToolArgs>;
  readonly run: (input: ToolArgs) => ToolResult;
};

/**
 * Every argument any tool accepts, in one type. Each tool still declares its
 * own strict schema -- that is what the model is shown and what rejects a
 * hallucinated parameter -- and re-parses its input; this shared type only
 * describes what a validated argument object can hold, so no tool's `run` has
 * to take `unknown`.
 */
export type ToolArgs = {
  readonly on?: string;
  readonly from?: string;
  readonly to?: string;
  readonly dimension?: Dimension;
  readonly limit?: number;
};

/** What a tool hands back: JSON, because that is what the model reads. */
export type JsonValue = string | number | boolean | null | readonly JsonValue[];
export type ToolResult = { readonly [key: string]: JsonValue | ToolResult | readonly ToolResult[] };

const NoArgs = z.object({}).strict();
const OnDate = z.object({ on: IsoDateSchema.optional() }).strict();
const Range = z.object({ from: IsoDateSchema.optional(), to: IsoDateSchema.optional() }).strict();
const Allocation = z
  .object({
    on: IsoDateSchema.optional(),
    dimension: z.enum(["kind", "currency", "account", "instrument"]).optional(),
  })
  .strict();
const Transactions = z
  .object({
    from: IsoDateSchema.optional(),
    to: IsoDateSchema.optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();

export const buildChatTools = (db: Db, userId: string): ChatTool[] => [
  {
    name: "get_holdings",
    description:
      "Nykyiset omistukset: määrä, hankintameno, markkina-arvo, tuotto ja paino. " +
      "Anna 'on' jos haluat tilanteen menneeltä päivältä.",
    schema: OnDate,
    run: (input) => {
      const { on = today() } = OnDate.parse(input);
      const rows = holdingsFor(db, userId, on);
      return {
        asOf: on,
        stale: rows.some((row) => row.stale),
        // Named here so an answer about total worth does not have to add cash in
        // prose -- which the system prompt forbids. get_cash breaks it down.
        cashEur: cashFor(db, userId, on).totalEur,
        holdings: rows.map((row) => ({
          name: row.name,
          isin: row.isin,
          kind: row.kind,
          currency: row.currency,
          quantity: row.quantity,
          costEur: row.costEur,
          valueEur: row.valueEur,
          unrealisedEur: row.unrealisedEur,
          weight: row.weight,
          // Named rather than hidden: an answer that quietly omits a holding
          // reads as one the owner does not have.
          unvaluableReason: row.valuationError ?? row.costBasisError?.message ?? null,
        })),
      };
    },
  },
  {
    name: "get_cash",
    description:
      "Sijoittamaton käteinen tileittäin ja valuutoittain. Käteinen lasketaan mukaan salkun " +
      "arvoon ja jakaumaan, mutta ei tuottolukuihin.",
    schema: OnDate,
    run: (input) => {
      const { on = today() } = OnDate.parse(input);
      const { rows, totalEur } = cashFor(db, userId, on);
      return {
        asOf: on,
        totalEur,
        balances: rows.map((row) => ({
          account: row.accountName,
          currency: row.currency,
          amount: row.amount,
          valueEur: row.valueEur,
        })),
        note:
          "Tilit, joiden aineistossa ei ole lainkaan käteistapahtumia (esim. OP:n " +
          "arvopaperinäkymä), eivät näy tässä lainkaan -- niiden saldoa ei voi johtaa.",
      };
    },
  },

  {
    name: "get_allocation",
    description:
      "Omistusten jakauma valitulla ulottuvuudella: kind (laji), currency (valuutta), " +
      "account (tili) tai instrument (arvopaperi).",
    schema: Allocation,
    run: (input) => {
      const { on = today(), dimension = "kind" } = Allocation.parse(input);
      const { txns, instruments, prices } = loadPortfolio(db, userId);
      const { slices, excludedInstrumentIds } = allocateBy(
        txns,
        instruments,
        prices,
        on,
        dimension,
      );
      const byId = new Map(instruments.map((i) => [i.id, i.name]));
      return {
        asOf: on,
        dimension,
        slices: slices.map((slice) => ({
          label: slice.label,
          valueEur: formatMoney(slice.valueEur),
          weight: slice.weight,
        })),
        excluded: excludedInstrumentIds.map((id) => byId.get(id) ?? `#${id}`),
      };
    },
  },
  {
    name: "get_returns",
    description:
      "Tuottoluvut: aikapainotettu (twr) ja oma tuotto (xirr, rahapainotettu), " +
      "sekä salkun arvo jakson lopussa.",
    schema: Range,
    run: (input) => {
      const { from = "2015-01-01", to = today() } = Range.parse(input);
      const { txns, instruments, prices } = loadPortfolio(db, userId);
      const series = valueSeries(txns, instruments, prices, from, to);
      const final = series.at(-1);
      const twrFlows = investedCashFlows(txns).filter((f) => f.date >= from && f.date <= to);

      let mwr: number | null = null;
      try {
        const flows = fundingCashFlows(txns)
          .filter((f) => f.date >= from && f.date <= to)
          .map((f) => ({ date: f.date, amountEur: negateMoney(f.amountEur) }));
        mwr = final ? xirr(flows, { date: final.date, amountEur: final.valueEur }) : null;
      } catch {
        // xirr refuses when it cannot converge or has too few flows. "Unknown"
        // is the honest answer, and the model is told to say so.
        mwr = null;
      }

      return {
        from,
        to,
        valueEur: final ? formatMoney(final.valueEur) : "0.00",
        stale: final?.stale ?? false,
        twr: twr(series, twrFlows),
        mwr,
        note:
          "twr on aikapainotettu tuotto koko jaksolta (ei vuosittaistettu). " +
          "mwr on vuosittainen sisäinen korkokanta. null tarkoittaa, ettei lukua voi laskea.",
      };
    },
  },
  {
    name: "get_value_series",
    description:
      "Salkun arvon kehitys jaksolla. Palauttaa enintään 60 pistettä tasavälein, " +
      "eli pitkältä jaksolta noin kuukausittain.",
    schema: Range,
    run: (input) => {
      const { from = "2015-01-01", to = today() } = Range.parse(input);
      const { txns, instruments, prices } = loadPortfolio(db, userId);
      const series = valueSeries(txns, instruments, prices, from, to);
      // Thinned rather than truncated: a truncated series would answer "how did
      // it develop" with only its beginning. 60 points is what a sentence about
      // the shape of a curve needs -- a daily series over several years costs
      // thousands of tokens per turn, and every one of them is re-sent on each
      // later round trip of the same conversation. The chart on the dashboard is
      // where the full resolution belongs.
      const step = Math.max(1, Math.ceil(series.length / MAX_SERIES_POINTS));
      return {
        from,
        to,
        points: series
          .filter((_, index) => index % step === 0 || index === series.length - 1)
          .map((point) => ({ date: point.date, valueEur: formatMoney(point.valueEur) })),
      };
    },
  },
  {
    name: "get_transactions",
    description:
      "Tapahtumat aikajärjestyksessä, uusimmat ensin. Rajaa 'from'/'to' päivillä ja " +
      "'limit' määrällä (oletus 25, enintään 200).",
    schema: Transactions,
    run: (input) => {
      const {
        from = "1900-01-01",
        to = today(),
        limit = DEFAULT_TXN_LIMIT,
      } = Transactions.parse(input);
      const { txns, instruments } = loadPortfolio(db, userId);
      const byId = new Map(instruments.map((i) => [i.id, i.name]));
      const rows = txns
        .filter((t) => t.tradeDate >= from && t.tradeDate <= to)
        .sort((a, b) =>
          a.tradeDate === b.tradeDate ? b.id - a.id : a.tradeDate < b.tradeDate ? 1 : -1,
        )
        .slice(0, limit);
      return {
        from,
        to,
        // Said out loud so an answer cannot imply it saw everything.
        returned: rows.length,
        truncated: rows.length === limit,
        transactions: rows.map((t) => ({
          date: t.tradeDate,
          type: t.type,
          instrument: t.instrumentId === null ? null : (byId.get(t.instrumentId) ?? null),
          quantity: formatQuantity(t.quantity),
          amountEur: formatMoney(t.amount),
          currency: t.currency,
        })),
      };
    },
  },
  {
    name: "get_instruments",
    description: "Rekisteröidyt arvopaperit: nimi, ISIN, laji, valuutta ja hintalähde.",
    schema: NoArgs,
    run: (input) => {
      NoArgs.parse(input);
      const { txns, instruments } = loadPortfolio(db, userId);
      // The instrument registry is shared across the household by design (one
      // ISIN, one row), so it is narrowed here to what this user's own ledger
      // actually references -- chat must not name a fund only someone else owns.
      const owned = new Set(txns.map((t) => t.instrumentId));
      return {
        instruments: instruments
          .filter((i) => owned.has(i.id))
          .map((i) => ({
            name: i.name,
            isin: i.isin,
            kind: i.kind,
            currency: i.currency,
            priceSource: i.priceSource,
          })),
      };
    },
  },
];

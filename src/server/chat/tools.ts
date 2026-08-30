import { z } from "zod";

import { allocateBy, type Dimension } from "../../core/allocation";
import { cashBalancesAt, valueCash } from "../../core/cash";
import { notSpendingIds } from "../spending/internal";
import { categoriseWith, rulesFor } from "../spending/rules";
import { summariseSpending } from "../spending/summary";
import { calculate } from "./calculator";
import { fundingCashFlows, investedCashFlows } from "../../core/ledger";
import { formatMoney, formatQuantity, negateMoney } from "../../core/money";
import { twr, valueSeries, xirr } from "../../core/returns";
import type { IsoDate } from "../../core/types";
import type { getDb } from "../db";
import { driftReportFor, feeReportFor } from "../rebalance";
import { taxYearFor, taxYearsFor } from "../tax";
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
  readonly groupBy?: "category" | "counterparty";
  readonly limit?: number;
  readonly operation?: "sum" | "subtract" | "multiply" | "divide" | "percent" | "average";
  readonly values?: readonly string[];
  readonly year?: number;
  /** The allocation dimension a drift question is asked on. */
  readonly by?: Dimension;
};

/** What a tool hands back: JSON, because that is what the model reads. */
export type JsonValue = string | number | boolean | null | readonly JsonValue[];
export type ToolResult = { readonly [key: string]: JsonValue | ToolResult | readonly ToolResult[] };

const NoArgs = z.object({}).strict();
const OnDate = z.object({ on: IsoDateSchema.optional() }).strict();
const Range = z.object({ from: IsoDateSchema.optional(), to: IsoDateSchema.optional() }).strict();
const Grouping = z
  .object({ by: z.enum(["kind", "currency", "account", "instrument"]).optional() })
  .strict();
const TaxYear = z.object({ year: z.number().int().min(1990).max(2100).optional() }).strict();
const Allocation = z
  .object({
    on: IsoDateSchema.optional(),
    dimension: z.enum(["kind", "currency", "account", "instrument"]).optional(),
  })
  .strict();
const Spending = z
  .object({
    from: IsoDateSchema.optional(),
    to: IsoDateSchema.optional(),
    groupBy: z.enum(["category", "counterparty"]).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict();
const Calculation = z
  .object({
    operation: z.enum(["sum", "subtract", "multiply", "divide", "percent", "average"]),
    /** Decimal strings, so nothing is lost on the way in. */
    values: z.array(z.string()).min(1).max(200),
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
      "Sijoittamaton käteinen tileittäin ja valuutoittain. Erottelee heti käytettävissä " +
      "olevan rahan ja määräaikaistalletukset, joita ei voi nostaa ennen eräpäivää. " +
      "Käteinen on mukana salkun arvossa ja jakaumassa, mutta ei tuottoluvuissa.",
    schema: OnDate,
    run: (input) => {
      const { on = today() } = OnDate.parse(input);
      const { rows, totalEur, availableEur, lockedEur } = cashFor(db, userId, on);
      return {
        asOf: on,
        totalEur,
        // Money in a fixed-term deposit is the owner's but cannot be spent until
        // it matures; one figure covering both would answer "what do I have
        // available" wrongly.
        availableEur,
        lockedEur,
        balances: rows.map((row) => ({
          account: row.accountName,
          currency: row.currency,
          amount: row.amount,
          valueEur: row.valueEur,
          locked: row.locked,
          availableFrom: row.availableFrom,
        })),
        note:
          "Tilit, joiden aineistossa ei ole lainkaan käteistapahtumia (esim. OP:n " +
          "arvopaperinäkymä), eivät näy tässä lainkaan -- niiden saldoa ei voi johtaa. " +
          "locked: true tarkoittaa määräaikaistalletusta, jota ei voi nostaa ennen " +
          "availableFrom-päivää.",
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
      const { txns, cashTxns, instruments, prices } = loadPortfolio(db, userId);
      const cash = valueCash(cashBalancesAt(cashTxns, on), prices.fxOn, on);
      const { slices, excludedInstrumentIds } = allocateBy(
        txns,
        instruments,
        prices,
        on,
        dimension,
        cash,
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
      // Invested rows only: a bank account's spending is not portfolio
      // performance (see valuation.ts's `Portfolio.investedTxns`).
      const { investedTxns, instruments, prices } = loadPortfolio(db, userId);
      const series = valueSeries(investedTxns, instruments, prices, from, to);
      const final = series.at(-1);
      const twrFlows = investedCashFlows(investedTxns).filter(
        (f) => f.date >= from && f.date <= to,
      );

      let mwr: number | null = null;
      try {
        const flows = fundingCashFlows(investedTxns)
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
      const { investedTxns, instruments, prices } = loadPortfolio(db, userId);
      const series = valueSeries(investedTxns, instruments, prices, from, to);
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
    name: "get_spending",
    description:
      "Mihin rahaa on kulunut pankkitileiltä jaksolla. groupBy: category (luokittain, " +
      "esim. ruoka, ravintolat, liikenne) tai counterparty (saajittain). Summat on " +
      "laskettu valmiiksi -- älä laske niitä itse yhteen.",
    schema: Spending,
    run: (input) => {
      const {
        from = "1900-01-01",
        to = today(),
        groupBy = "category",
        limit = 15,
      } = Spending.parse(input);
      // Bank rows only, minus the movements: a share purchase is money leaving
      // too, and counting it -- or a transfer to savings, or the credit card
      // bill -- would report the year's biggest movement as its biggest expense.
      const { txns, bankAccountIds } = loadPortfolio(db, userId);
      const bank = new Set(bankAccountIds);
      const moved = notSpendingIds(txns, bank);
      const summary = summariseSpending(
        txns.filter((txn) => bank.has(txn.accountId) && !moved.has(txn.id)),
        { from, to, by: groupBy, limit, rules: rulesFor(db, userId) },
      );
      return {
        from: summary.from,
        to: summary.to,
        totalEur: summary.totalEur,
        groups: summary.groups.map((group) => ({
          label: group.label,
          totalEur: group.totalEur,
          count: group.count,
        })),
        // Said out loud so an answer cannot imply every euro was classified.
        uncategorisedShare: summary.uncategorisedShare,
        note:
          "Summat ovat negatiivisia (rahaa ulos). Luokittelu perustuu maksun tekstiin, " +
          "joten osa päätyy luokkaan Muu. Kerro uncategorisedShare jos se on merkittävä.",
      };
    },
  },

  {
    name: "get_uncategorised_spending",
    description:
      "Maksut, joita sääntöpohjainen luokittelu ei tunnistanut (luokka Muu), saajittain " +
      "ja summattuna. Käytä tätä kun haluat arvioida itse mihin ne kuuluvat.",
    schema: Spending,
    run: (input) => {
      const { from = "1900-01-01", to = today(), limit = 30 } = Spending.parse(input);
      const { txns, bankAccountIds } = loadPortfolio(db, userId);
      const bank = new Set(bankAccountIds);
      const rules = rulesFor(db, userId);
      const moved = notSpendingIds(txns, bank);
      const summary = summariseSpending(
        txns.filter(
          (txn) =>
            bank.has(txn.accountId) &&
            !moved.has(txn.id) &&
            categoriseWith(txn.note ?? "", rules) === "muu",
        ),
        { from, to, by: "counterparty", limit, rules },
      );
      return {
        from,
        to,
        totalEur: summary.totalEur,
        merchants: summary.groups.map((group) => ({
          name: group.label,
          totalEur: group.totalEur,
          count: group.count,
        })),
        note:
          "Nämä eivät osu mihinkään sääntöön. Voit arvioida luokan nimen perusteella, " +
          "mutta sano selvästi että kyse on arviosta -- sääntöpohjaiset luvut ovat varmoja, " +
          "arviosi ei.",
      };
    },
  },

  {
    name: "calculate",
    description:
      "Laskee tarkasti sentin tarkkuudella: sum, subtract, multiply, divide, percent, average. " +
      "Käytä tätä aina kun johdat luvun toisista luvuista -- älä laske päässäsi.",
    schema: Calculation,
    run: (input) => {
      const { operation, values } = Calculation.parse(input);
      try {
        return calculate({ operation, values });
      } catch (cause) {
        return { error: cause instanceof Error ? cause.message : "Laskenta epäonnistui" };
      }
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
  {
    name: "get_drift",
    description:
      "Ero tavoitejakaumaan: kunkin erän tavoite, nykyosuus ja erotus prosentteina ja euroina, " +
      "sekä kulut vuosittain. by: kind (oletus), currency, account tai instrument. " +
      "Älä ehdota kauppoja -- kerro ero ja mitä sen korjaaminen vaatisi.",
    schema: Grouping,
    run: (input) => {
      const { by = "kind" } = Grouping.parse(input);
      const on = today();
      // Reads through the same functions the Tasapaino screen calls, so chat
      // and the screen cannot disagree about how far off the portfolio is.
      const drift = driftReportFor(db, userId, by, on);
      const fees = feeReportFor(db, userId);
      return {
        asOf: on,
        groupBy: by,
        totalEur: drift.totalEur,
        // Said out loud: one unpriceable holding makes every slice's euro
        // figure wrong by an unknown amount, not only its own.
        incomplete: drift.incomplete,
        rows: drift.rows.map((row) => ({
          erä: row.label,
          tavoite: row.targetPercent,
          nyt: row.actualPercent,
          ero: row.driftPercent,
          siirrettävä: row.driftEur,
          tavoitteessa: row.withinBand,
          ilmanTavoitetta: row.untargeted,
        })),
        fees: fees.map((year) => ({
          year: year.year,
          kulutEur: year.totalEur,
          pidätettyVeroEur: year.withheldTaxEur,
        })),
        note:
          "Ilman tavoitetta oleville erille ei lasketa eroa. Pidätetty pääomatulovero ei ole kulu " +
          "vaan veroa voitosta. Et anna sijoitusneuvoja etkä kehota myymään.",
      };
    },
  },
  {
    name: "get_tax_year",
    description:
      "Verovuoden luvut: luovutusvoitot ja -tappiot, osingot ja osakesäästötilin nostot. " +
      "Nämä ovat veroilmoituksen tarkistamista varten -- veron määrää ei lasketa, koska " +
      "pääomatulon veroprosentti riippuu myös tuloista joita sovellus ei näe. Ilman " +
      "vuotta palautetaan viimeisin vuosi jolla on verotettavia tapahtumia.",
    schema: TaxYear,
    run: (input) => {
      const { year } = TaxYear.parse(input);
      const years = taxYearsFor(db, userId);
      // A ledger with no taxable event at all still answers, for the year we
      // are in: an empty report is the true answer to "what do I owe on 2026",
      // and `availableYears` says which years have anything in them.
      const chosen = year ?? years[0] ?? Number(today().slice(0, 4));

      // Reads through the same function the Verot screen calls, so chat and
      // the screen cannot disagree about a figure someone files on.
      const report = taxYearFor(db, userId, chosen);
      return {
        year: report.year,
        availableYears: years,
        exempt: report.exempt,
        totalSalePriceEur: report.totalSalePriceEur,
        gainsEur: report.gainsEur,
        lossesEur: report.lossesEur,
        taxableGainEur: report.netEur,
        lossCarriedOut: report.lossCarriedOut,
        dividendTaxableEur: report.dividendTaxableEur,
        // Said out loud so an answer cannot present a net figure as a gross one.
        dividendWithholdingMissing: report.dividends.some((row) => !row.withholdingRecorded),
        ost: report.ost.map((account) => ({
          account: account.accountName,
          depositedEur: account.depositedEur,
          capRemainingEur: account.capRemainingEur,
          withdrawals: account.withdrawals.map((row) => ({
            date: row.withdrawnOn,
            amountEur: row.amountEur,
            taxableEur: row.taxableEur,
            blocked: row.blockedBy,
          })),
        })),
        note:
          "Veron määrää ei lasketa. Jos jokin osakesäästötilin nosto on blocked, sen " +
          "veronalaista osuutta ei voitu laskea -- kerro syy äläkä arvaa lukua.",
      };
    },
  },
];

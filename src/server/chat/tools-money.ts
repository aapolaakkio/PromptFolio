import { z } from "zod";

import { EUR, formatMoney, parseMoney } from "../../core/money";
import { cashFlowFor } from "../spending/cashflow";
import { CATEGORY_LABELS, labelForCategory } from "../spending/categories";
import { cashlessAccountIds } from "../spending/internal";
import { monthlyByCategory, monthlyFlows } from "../spending/monthly";
import { rulesFor } from "../spending/rules";
import { classifiedTransactions } from "../spending/transactions";
import { depositPlanFor } from "../rebalance";
import { loadPortfolio } from "../valuation";
import {
  type ChatTool,
  type Db,
  DEFAULT_TXN_LIMIT,
  IsoDateSchema,
  MAX_SERIES_POINTS,
  today,
  type ToolResult,
} from "./tool-types";

/** The earliest date a question may reach back to, as the HTTP routes use. */
const LEDGER_START = "1900-01-01";

const CATEGORY_KEYS = Object.keys(CATEGORY_LABELS);

const CashFlow = z
  .object({ from: IsoDateSchema.optional(), to: IsoDateSchema.optional() })
  .strict();

const Trend = z
  .object({
    from: IsoDateSchema.optional(),
    to: IsoDateSchema.optional(),
    // Named rather than free text: a category the model invents would silently
    // report zero, which reads as "you spent nothing on that".
    // SAFETY: `z.enum` needs a non-empty tuple, and `CATEGORY_LABELS` is a
    // literal object with an entry for every category -- it cannot be empty
    // without the app having no spending categories at all.
    category: z.enum(CATEGORY_KEYS as [string, ...string[]]).optional(),
  })
  .strict();

const Deposit = z
  .object({
    amountEur: z
      .string()
      .regex(/^\d+([.,]\d{1,2})?$/, 'Summa on annettava euroina, esimerkiksi "1500.00"')
      .refine((text) => parseMoney(text, EUR).minor > 0n, "Summan on oltava suurempi kuin nolla"),
    on: IsoDateSchema.optional(),
    by: z.enum(["kind", "currency", "account", "instrument"]).optional(),
  })
  .strict();

const Classified = z
  .object({
    from: IsoDateSchema.optional(),
    to: IsoDateSchema.optional(),
    search: z.string().min(1).max(100).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();

/**
 * The tools that answer where money went and where the next of it should go.
 *
 * They live beside `tools.ts` rather than in it because that file already holds
 * twelve, and a single module listing every tool is the one that nobody can
 * read to the end. Same contract, same wire rules: read-only, decimal strings,
 * a bound user id the model cannot reach past.
 */
export const buildMoneyTools = (db: Db, userId: string): ChatTool[] => [
  {
    name: "get_cash_flow",
    description:
      "Jakson rahavirta: paljonko tuli sisään, paljonko meni ulos, paljonko sijoitettiin ja " +
      "mitä jäi. Vastaa kysymykseen 'menikö kesäkuussa enemmän kuin tuli'. Summat on laskettu " +
      "valmiiksi -- älä laske niitä itse yhteen.",
    schema: CashFlow,
    run: (input) => {
      const { from = LEDGER_START, to = today() } = CashFlow.parse(input);
      const { txns, bankAccountIds } = loadPortfolio(db, userId);
      const bank = new Set(bankAccountIds);
      // Every account that is not a bank one holds investments, and its own
      // deposits are the reliable record of money moved into it -- the same
      // derivation /api/spending/cashflow makes.
      const invested = new Set(
        txns.map((txn) => txn.accountId).filter((accountId) => !bank.has(accountId)),
      );
      const flow = cashFlowFor({
        txns,
        rules: rulesFor(db, userId),
        bankAccountIds: bank,
        investedAccountIds: invested,
        cashlessInvestedAccountIds: cashlessAccountIds(txns, bank),
        from,
        to,
      });

      const totalOf = (id: string): string =>
        flow.nodes.find((node) => node.id === id)?.totalEur ?? "0.00";
      // A shortfall is drawn as a flow *into* income, so that link is what says
      // the period spent more than it earned. The figure itself stays positive:
      // a negative "left over" reads as money sitting in the account.
      const shortfall = flow.links.some((link) => link.from === "leftover");

      return {
        from: flow.from,
        to: flow.to,
        incomeEur: totalOf("income"),
        spendingEur: totalOf("expenses"),
        taxesEur: totalOf("taxes"),
        investedEur: totalOf("invested"),
        leftoverEur: totalOf("leftover"),
        spentMoreThanEarned: shortfall,
        byCategory: flow.nodes
          .filter((node) => node.id.startsWith("out:"))
          .map((node) => ({ label: node.label, totalEur: node.totalEur })),
        note:
          "Omien tilien väliset siirrot, sijoituksiin menneet maksut ja luottokortin laskun " +
          "maksu eivät ole kulutusta eivätkä tuloa, joten ne on jätetty pois. " +
          (shortfall ? "Jakso oli alijäämäinen: erotus katettiin säästöistä." : ""),
      };
    },
  },

  {
    name: "get_spending_trend",
    description:
      "Kulutus kuukausi kerrallaan: tulot, menot ja erotus per kuukausi, tai yhden luokan " +
      "kehitys kun category annetaan. Käytä tätä kun kysytään onko jokin kasvanut tai " +
      "laskenut -- älä kutsu get_spending kerran per kuukausi.",
    schema: Trend,
    run: (input): ToolResult => {
      const { from = LEDGER_START, to = today(), category } = Trend.parse(input);
      const { txns, bankAccountIds } = loadPortfolio(db, userId);
      const shared = {
        txns,
        rules: rulesFor(db, userId),
        bankAccountIds: new Set(bankAccountIds),
        from,
        to,
      };

      if (category !== undefined) {
        const byCategory = monthlyByCategory({ ...shared, labelFor: labelForCategory });
        const months = byCategory.months.slice(-MAX_SERIES_POINTS);
        return {
          from,
          to,
          category,
          label: labelForCategory(category),
          months: months.map((month) => ({
            month: month.month,
            totalEur: month.byCategory[category] ?? "0.00",
          })),
          truncated: byCategory.months.length > months.length,
          note: "Summat ovat positiivisia lukuja siitä mitä kului.",
        };
      }

      const all = monthlyFlows(shared);
      const months = all.slice(-MAX_SERIES_POINTS);
      return {
        from,
        to,
        months: months.map((month) => ({
          month: month.month,
          incomeEur: month.incomeEur,
          expensesEur: month.expensesEur,
          netEur: month.netEur,
        })),
        truncated: all.length > months.length,
        note:
          "expensesEur on positiivinen luku siitä mitä kului. netEur on tulot miinus menot: " +
          "negatiivinen netEur tarkoittaa että kuukausi oli alijäämäinen.",
      };
    },
  },

  {
    name: "get_deposit_plan",
    description:
      "Mihin uusi raha kannattaa laittaa, jotta jakauma lähestyy tavoitetta. Anna summa " +
      "euroina. Ehdottaa vain ostoja, ei koskaan myyntejä.",
    schema: Deposit,
    run: (input) => {
      const { amountEur, on = today(), by = "kind" } = Deposit.parse(input);
      const deposit = parseMoney(amountEur, EUR);
      const allocations = depositPlanFor(db, userId, by, on, deposit);

      return {
        asOf: on,
        groupBy: by,
        depositEur: formatMoney(deposit),
        allocations: allocations.map((allocation) => ({
          label: allocation.label,
          amountEur: allocation.amountEur,
        })),
        note:
          allocations.length === 0
            ? "Tälle ulottuvuudelle ei ole asetettu tavoitetta, joten jakoa ei voi laskea. " +
              "Tavoitteen voi asettaa Tasapaino-sivulla."
            : "Osuudet on mitattu tavoitteesta, joka lasketaan talletuksen jälkeisestä " +
              "kokonaisarvosta. Tämä ei realisoi voittoa eikä aiheuta veroa. " +
              "Et anna sijoitusneuvoja etkä ehdota myyntejä.",
      };
    },
  },

  {
    name: "get_transaction_class",
    description:
      "Yksittäiset pankkitapahtumat ja se luokka jonka ne saivat: mikä luokka, laskettiinko " +
      "kulutukseen, ja jos ei niin miksi (oma siirto, sijoitus, tulo, alkusaldo). Käytä tätä " +
      "kun kysytään miksi jokin ei näy kulutuksessa. search rajaa tapahtuman omaan tekstiin.",
    schema: Classified,
    run: (input) => {
      const {
        from = LEDGER_START,
        to = today(),
        search,
        limit = DEFAULT_TXN_LIMIT,
      } = Classified.parse(input);
      const { txns, bankAccountIds } = loadPortfolio(db, userId);
      const bank = new Set(bankAccountIds);
      const all = classifiedTransactions({
        txns,
        rules: rulesFor(db, userId),
        bankAccountIds: bank,
        cashlessAccountIds: cashlessAccountIds(txns, bank),
        labelFor: labelForCategory,
        from,
        to,
      });

      const needle = search?.toLowerCase();
      const matching =
        needle === undefined ? all : all.filter((txn) => txn.text.toLowerCase().includes(needle));
      const shown = matching.slice(0, limit);

      return {
        from,
        to,
        count: matching.length,
        transactions: shown.map((txn) => ({
          date: txn.date,
          text: txn.text,
          amountEur: txn.amountEur,
          category: txn.category,
          categoryLabel: txn.categoryLabel,
          counted: txn.counted,
          excludedReason: txn.excludedReason,
        })),
        truncated: matching.length > shown.length,
        note:
          "counted=false tarkoittaa ettei rivi ole mukana kulutusluvuissa, ja excludedReason " +
          "kertoo miksi. Luokka perustuu tapahtuman tekstiin, joten tuntematon maksaja on Muu.",
      };
    },
  },
];

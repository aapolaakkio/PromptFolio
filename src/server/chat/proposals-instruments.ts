import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { formatMoney, money as moneyOf, parseCurrency, parseMoney } from "../../core/money.ts";
import {
  InstrumentCreate,
  InstrumentEdit,
  toBasisPoints,
  FundChargeInput,
  PriceInput,
} from "../action-inputs.ts";
import { forecastRates, instrumentCosts, prices } from "../db/schema.ts";
import { ForecastRateInput } from "../forecast-inputs.ts";
import { parseChargePercent } from "../instruments/costs.ts";
import { listInstruments } from "../instruments/store.ts";
import { listPlan } from "../monthly-plan.ts";
import { assertNotFuture } from "../prices/manual.ts";
import {
  AWAITS,
  canonical,
  HOUSEHOLD_SHARED,
  instrumentLabel,
  newId,
  ownInstrument,
  shownCode,
  shownTicker,
  text,
} from "./proposal-kit.ts";
import type { Fact, Proposal } from "./proposal-schema.ts";
import type { Db, ProposalArea, ProposalTool, ToolArgs } from "./tool-types.ts";

const INSTRUMENTS: ProposalArea = {
  name: "Instruments",
  sentence:
    "add an instrument, change an instrument's price source, record a price for a date, set a fund's yearly fee and " +
    "set your own forecast growth rate for an instrument",
};

const SOURCE_LABEL = { yahoo: "Yahoo Finance", page: "Web page", manual: "Manual prices" } as const;
const SOURCE_WORDING = {
  yahoo: "Yahoo Finance",
  page: "a web page",
  manual: "manual prices",
} as const;

// The page check is a model call and a fetch, so it runs only in the save the owner confirms.
const proposePriceSource = async (db: Db, userId: string, raw: ToolArgs): Promise<Proposal> => {
  const input = InstrumentEdit.parse(raw);
  const instrument = await ownInstrument(db, userId, input.id);
  const code = shownCode(input.priceSource, input.sourceKey.trim());
  const name = instrumentLabel(instrument);
  const changesCurrency = instrument.currency !== input.currency;
  const isPage = input.priceSource === "page";
  const facts: Fact[] = [
    text("Instrument", name),
    text("Source", SOURCE_LABEL[input.priceSource]),
    ...(code === null ? [] : [{ kind: "code" as const, label: "Code", code }]),
    text("Currency", input.currency),
    ...(changesCurrency
      ? [text("Stored prices", `Deleted: the currency changes from ${instrument.currency}`)]
      : []),
    ...(isPage ? [text("Check", "The page is read when you confirm")] : []),
  ];
  const summary = [
    `Change the price source of ${name} to ${SOURCE_WORDING[input.priceSource]}`,
    code === null ? "" : ` (${code})`,
    `, quoted in ${input.currency}.`,
    changesCurrency
      ? ` The currency changes from ${instrument.currency}, so its stored prices are deleted.`
      : "",
    isPage ? " The page is checked when you confirm." : "",
  ].join("");
  return {
    proposalId: newId(),
    action: "price_source",
    title: "Change the price source",
    facts,
    summary,
    input,
  };
};

const KIND_LABEL = { stock: "Stock", etf: "ETF", fund: "Fund", cash: "Cash" } as const;

const code = (label: string, value: string): Fact => ({ kind: "code", label, code: value });

// The page check is a model call and a fetch, so it runs only in the save the owner confirms.
const proposeCreateInstrument = async (db: Db, raw: ToolArgs): Promise<Proposal> => {
  const input = InstrumentCreate.parse(raw);
  const shown = shownCode(input.priceSource, (input.sourceKey ?? "").trim());
  const ticker = input.ticker === null ? null : shownTicker(input.ticker);
  const registry = await listInstruments(db);
  const twin = registry.find((item) =>
    input.isin === undefined
      ? item.isin === null && item.name === input.name
      : item.isin === input.isin,
  );
  if (twin !== undefined) {
    throw new Error(`Already registered as instrument ${twin.id} (${instrumentLabel(twin)})`);
  }
  const facts: Fact[] = [
    text("Name (as it will be saved)", input.name),
    input.isin === undefined ? text("ISIN", "None") : code("ISIN", input.isin),
    ticker === null ? text("Ticker", "None") : code("Ticker", ticker),
    text("Kind", KIND_LABEL[input.kind]),
    text("Currency", input.currency),
    text("Source", SOURCE_LABEL[input.priceSource]),
    ...(shown === null ? [] : [code("Code", shown)]),
    ...(input.priceSource === "page" ? [text("Check", "The page is read when you confirm")] : []),
  ];
  return {
    proposalId: newId(),
    action: "create_instrument",
    title: "Add an instrument",
    facts,
    summary:
      `Add the instrument ${input.isin === undefined ? input.name : `${input.name} (${input.isin})`}, ` +
      `a ${KIND_LABEL[input.kind].toLowerCase()} quoted in ${input.currency}, priced by ` +
      `${SOURCE_WORDING[input.priceSource]}${shown === null ? "" : ` (${shown})`}.`,
    input,
  };
};

const percentText = (bp: number): string => `${(bp / 100).toFixed(2)} %`;

const proposeFundFee = async (db: Db, userId: string, raw: ToolArgs): Promise<Proposal> => {
  const input = FundChargeInput.parse(raw);
  const typed = input.percent.trim();
  if (typed === "") throw new Error("To remove a fee, use propose_clear_fund_fee");
  const bp = parseChargePercent(typed);
  if (bp === null) throw new Error("The fee must be a percentage from 0 to 5, for example 0.20");
  const fund = await ownInstrument(db, userId, input.id);
  if (fund.kind !== "fund" && fund.kind !== "etf") {
    throw new Error("A fee can only be set for a fund or an ETF");
  }
  const current = await db
    .select()
    .from(instrumentCosts)
    .where(eq(instrumentCosts.instrumentId, fund.id))
    .get();
  const bpNow = current?.ongoingChargeBp ?? null;
  const was =
    bpNow === null
      ? "No fee recorded"
      : `${percentText(bpNow)} a year (${current?.source === "user" ? "yours" : "looked up"})`;
  const name = instrumentLabel(fund);
  return {
    proposalId: newId(),
    action: "fund_fee",
    title: "Set a fund's fee",
    facts: [
      text("Fund", name),
      text("Ongoing charge", `${percentText(bp)} a year`),
      text("Replaces", was),
      HOUSEHOLD_SHARED,
    ],
    summary: `Set the ongoing charge of ${name} to ${percentText(bp)} a year (was: ${was}).`,
    input,
  };
};

/** An instrument the caller holds or plans to buy: the forecast covers both. */
export const forecastInstrument = async (db: Db, userId: string, id: number) => {
  try {
    return await ownInstrument(db, userId, id);
  } catch (cause) {
    const planned = (await listPlan(db, userId)).rows.some((row) => row.instrumentId === id);
    const instrument = (await listInstruments(db)).find((item) => item.id === id);
    if (!planned || instrument === undefined) throw cause;
    return instrument;
  }
};

/** The user's stored rate for one instrument, worded for a card. */
export const storedRate = async (db: Db, userId: string, instrumentId: number) => {
  const row = await db
    .select({ rateBp: forecastRates.rateBp })
    .from(forecastRates)
    .where(and(eq(forecastRates.userId, userId), eq(forecastRates.instrumentId, instrumentId)))
    .get();
  return row === undefined ? null : `${percentText(row.rateBp)} a year (yours)`;
};

const proposeForecastRate = async (db: Db, userId: string, raw: ToolArgs): Promise<Proposal> => {
  const input = ForecastRateInput.parse(raw);
  const instrument = await forecastInstrument(db, userId, input.instrumentId);
  const signed = toBasisPoints(input.ratePercent);
  const rate = `${percentText(signed)} a year${signed < 0 ? " (a fall)" : ""}`;
  const was = (await storedRate(db, userId, instrument.id)) ?? "The rate measured from past prices";
  const name = instrumentLabel(instrument);
  return {
    proposalId: newId(),
    action: "forecast_rate",
    title: "Set a forecast rate",
    facts: [text("Instrument", name), text("Yearly growth", rate), text("Replaces", was)],
    summary: `Use ${rate} as the expected growth of ${name} in forecasts (replaces: ${was}).`,
    input,
  };
};

/** The saved input stays the form's; `source` only labels the card. */
const RecordPriceInput = PriceInput.extend({ source: z.string().trim().max(120).optional() });

const storedPrice = async (db: Db, instrumentId: number, date: string) => {
  const row = await db
    .select()
    .from(prices)
    .where(and(eq(prices.instrumentId, instrumentId), eq(prices.date, date)))
    .get();
  return row === undefined
    ? null
    : `${formatMoney(moneyOf(BigInt(row.close), row.currency))} ${row.currency}`;
};

const proposeRecordPrice = async (db: Db, userId: string, raw: ToolArgs): Promise<Proposal> => {
  const { source, ...input } = RecordPriceInput.parse(raw);
  assertNotFuture(input.date);
  const instrument = await ownInstrument(db, userId, input.instrumentId);
  const currency = parseCurrency(instrument.currency);
  const price = canonical(input.price, currency);
  if (parseMoney(input.price, currency).minor <= 0n) throw new Error("The price must be positive");
  const was = await storedPrice(db, instrument.id, input.date);
  const name = instrumentLabel(instrument);
  return {
    proposalId: newId(),
    action: "record_price",
    title: "Record a manual price",
    facts: [
      text("Instrument", name),
      { kind: "money", label: "Price", amount: price, currency },
      text("Currency", `${currency}, the instrument's currency`),
      text("Date", input.date),
      ...(was === null ? [] : [text("Replaces", was)]),
      ...(source === undefined || source === ""
        ? []
        : [text("Source (stated by the assistant)", source)]),
      HOUSEHOLD_SHARED,
    ],
    summary:
      `Record a manual price of ${price} ${currency} for ${name} on ${input.date}` +
      `${was === null ? "" : ` (replaces ${was})`}.`,
    input,
  };
};

export const buildInstrumentProposals = (db: Db, userId: string): ProposalTool[] => [
  {
    area: INSTRUMENTS,
    name: "propose_create_instrument",
    description:
      "Proposes registering a new instrument: name, isin (required unless priceSource is manual), " +
      "ticker or null, kind (stock, etf, fund, cash), currency, priceSource (yahoo with sourceKey " +
      "the upper-case ticker, page with sourceKey a public https URL, or manual with no sourceKey). " +
      "Check get_instruments first: an instrument already registered is refused." +
      AWAITS,
    schema: InstrumentCreate,
    propose: (input) => proposeCreateInstrument(db, input),
  },
  {
    area: INSTRUMENTS,
    name: "propose_price_source",
    description:
      "Proposes an instrument's price source: yahoo (sourceKey is the upper-case ticker), " +
      "page (sourceKey is a public https URL) or manual (sourceKey empty), with its quotation currency. id comes from " +
      "get_instruments. A changed currency deletes the stored prices." +
      AWAITS,
    schema: InstrumentEdit,
    propose: (input) => proposePriceSource(db, userId, input),
  },
  {
    area: INSTRUMENTS,
    name: "propose_record_price",
    description:
      "Proposes one manual price for one instrument the owner holds on one date: instrumentId " +
      "from get_instruments, date YYYY-MM-DD and not in the future, price a decimal string in the " +
      "instrument's currency, source optional text (up to 120 characters) saying where the price " +
      "came from: a find_price source (for example 'own trade on 2021-01-20' or 'Yahoo close'), " +
      "a web page found with web search, by its address, or the owner's own message in this " +
      "conversation, quoted as such. Look with find_price first. The price comes only from the " +
      "owner's own words, a figure a tool returned in this answer (find_price, or the owner's own " +
      "trade price from get_transactions), or a page web search found in this answer; never " +
      "estimate or invent one. It replaces a price already stored for " +
      "that date, and prices are shared by the whole household." +
      AWAITS,
    schema: RecordPriceInput,
    propose: (input) => proposeRecordPrice(db, userId, input),
  },
  {
    area: INSTRUMENTS,
    name: "propose_fund_fee",
    description:
      "Proposes the owner's own yearly ongoing charge for one fund or ETF they hold: id from " +
      'get_instruments, percent a decimal string from 0 to 5 ("0.20"). It replaces any looked-up fee.' +
      AWAITS,
    schema: FundChargeInput,
    propose: (input) => proposeFundFee(db, userId, input),
  },
  {
    area: INSTRUMENTS,
    name: "propose_forecast_rate",
    description:
      "Proposes the owner's own expected yearly growth for one instrument they hold or plan to buy, " +
      "used by forecasts instead of the measured rate: instrumentId from get_instruments or " +
      'get_monthly_plan, ratePercent a decimal string within ±50 ("6.5", "-2").' +
      AWAITS,
    schema: ForecastRateInput,
    propose: (input) => proposeForecastRate(db, userId, input),
  },
];

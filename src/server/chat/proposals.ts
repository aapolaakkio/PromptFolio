import type { Dimension } from "../../core/allocation.ts";
import { formatMoney, parseCurrency, parseMoney, type Currency } from "../../core/money.ts";
import { checkTargets } from "../../core/rebalance/targets.ts";
import { assertAccountOwned, listAccounts } from "../accounts.ts";
import {
  CashEntry,
  InstrumentEdit,
  PriceInput,
  TargetAllocationInput,
  toBasisPoints,
} from "../action-inputs.ts";
import { HttpError } from "../errors.ts";
import { driftReportFor } from "../rebalance.ts";
import { loadPortfolio } from "../valuation.ts";
import type { Proposal } from "./proposal-schema.ts";
import { type Db, type ProposalTool, type ToolArgs, today } from "./tool-types.ts";

const newId = (): string => crypto.randomUUID();

const money = (amount: string, currency: Currency): string => {
  try {
    return `${formatMoney(parseMoney(amount, currency))} ${currency}`;
  } catch {
    throw new Error("The amount is not a valid decimal number");
  }
};

/** The household registry is shared, so a proposal may only name an instrument this user's own ledger references. */
const ownInstrument = async (db: Db, userId: string, id: number) => {
  const { txns, instruments } = await loadPortfolio(db, userId);
  const instrument = instruments.find((candidate) => candidate.id === id);
  if (instrument === undefined || !txns.some((txn) => txn.instrumentId === id)) {
    throw new Error("Instrument not found");
  }
  return instrument;
};

/** The same check `addCashEntry` runs; its 404 text goes back to the model with the ids it may use. */
const ownAccountName = async (db: Db, userId: string, accountId: number): Promise<string> => {
  const accounts = await listAccounts(db, userId);
  try {
    await assertAccountOwned(userId, accountId);
  } catch (cause) {
    if (!(cause instanceof HttpError)) throw cause;
    const known = accounts.map((account) => `${account.id} (${account.name})`).join(", ");
    throw new Error(`${cause.message}. The owner's accounts: ${known || "none"}`);
  }
  return accounts.find((account) => account.id === accountId)?.name ?? `Account ${accountId}`;
};

const CASH_WORDING = {
  DEPOSIT: (amount: string, account: string) => `a deposit of ${amount} to ${account}`,
  WITHDRAWAL: (amount: string, account: string) => `a withdrawal of ${amount} from ${account}`,
  INTEREST: (amount: string, account: string) => `interest of ${amount} on ${account}`,
  OPENING_BALANCE: (amount: string, account: string) =>
    `an opening balance of ${amount} on ${account}`,
} as const;

const proposeRecordPrice = async (db: Db, userId: string, raw: ToolArgs): Promise<Proposal> => {
  const input = PriceInput.parse(raw);
  const instrument = await ownInstrument(db, userId, input.instrumentId);
  const currency = parseCurrency(instrument.currency);
  const price = money(input.price, currency);
  if (parseMoney(input.price, currency).minor <= 0n) throw new Error("The price must be positive");
  return {
    proposalId: newId(),
    action: "record_price",
    summary: `Record a manual price of ${price} for ${instrument.name} on ${input.date}.`,
    input,
  };
};

const proposeCashEntry = async (db: Db, userId: string, raw: ToolArgs): Promise<Proposal> => {
  const input = CashEntry.parse(raw);
  const account = await ownAccountName(db, userId, input.accountId);
  const what = CASH_WORDING[input.type](money(input.amount, input.currency), account);
  const note = input.note === undefined || input.note === "" ? "" : ` Note: "${input.note}".`;
  return {
    proposalId: newId(),
    action: "cash_entry",
    summary: `Record ${what} on ${input.tradeDate}.${note}`,
    input,
  };
};

/** Slice labels the owner recognises; by account, the stored account name. */
const sliceLabels = async (
  db: Db,
  userId: string,
  dimension: Dimension,
): Promise<ReadonlyMap<string, string>> => {
  const { rows } = await driftReportFor(db, userId, dimension, today());
  const names = new Map(
    (await listAccounts(db, userId)).map((account) => [String(account.id), account.name]),
  );
  return new Map(
    rows.map((row) => [
      row.key,
      dimension === "account" ? (names.get(row.key) ?? row.label) : row.label,
    ]),
  );
};

const proposeTargets = async (db: Db, userId: string, raw: ToolArgs): Promise<Proposal> => {
  const input = TargetAllocationInput.parse(raw);
  const labels = await sliceLabels(db, userId, input.dimension);
  const unknown = input.targets.find((target) => !labels.has(target.key));
  if (unknown !== undefined) {
    const known = [...labels].map(([key, label]) => `${key} (${label})`).join(", ");
    throw new Error(`Unknown key: ${unknown.key}. Keys for ${input.dimension}: ${known || "none"}`);
  }
  const error = checkTargets(
    input.targets.map((target) => ({
      key: target.key,
      weightBp: toBasisPoints(target.weightPercent),
    })),
  );
  if (error !== null) throw new Error(error.message);
  const lines = input.targets.map(
    (target) =>
      `${labels.get(target.key) ?? target.key} ${(toBasisPoints(target.weightPercent) / 100).toFixed(2)} %`,
  );
  return {
    proposalId: newId(),
    action: "target_allocation",
    summary: `Set the target allocation by ${input.dimension} to: ${lines.join(", ")}.`,
    input,
  };
};

const SOURCE_WORDING = {
  yahoo: (key: string) => `Yahoo Finance (${key})`,
  page: (key: string) => `a web page (${key})`,
  manual: () => "manual prices",
} as const;

// The page check is a model call and a fetch, so it runs only in the save the owner confirms.
const proposePriceSource = async (db: Db, userId: string, raw: ToolArgs): Promise<Proposal> => {
  const input = InstrumentEdit.parse(raw);
  const instrument = await ownInstrument(db, userId, input.id);
  const key = input.sourceKey.trim();
  if (input.priceSource !== "manual" && key === "") {
    throw new Error("A source code is required when the price source fetches prices automatically");
  }
  const parts = [
    `Change the price source of ${instrument.name} to ${SOURCE_WORDING[input.priceSource](key)}, quoted in ${input.currency}.`,
    instrument.currency === input.currency
      ? ""
      : ` The currency changes from ${instrument.currency}, so its stored prices are deleted.`,
    input.priceSource === "page" ? " The page is checked when you confirm." : "",
  ];
  return { proposalId: newId(), action: "price_source", summary: parts.join(""), input };
};

const AWAITS = " Saves nothing: the owner sees a card and decides with Confirm or Dismiss.";

/** The four owner actions the assistant may propose. Destructive ones (deleting imports, transactions, accounts) are deliberately absent. */
export const buildProposalTools = (db: Db, userId: string): ProposalTool[] => [
  {
    name: "propose_record_price",
    description:
      "Proposes recording a manual price for one instrument on one date. instrumentId comes " +
      "from get_instruments; price is a decimal string in the instrument's currency." +
      AWAITS,
    schema: PriceInput,
    propose: (input) => proposeRecordPrice(db, userId, input),
  },
  {
    name: "propose_cash_entry",
    description:
      "Proposes a manual cash entry on one account: DEPOSIT, WITHDRAWAL, INTEREST or " +
      "OPENING_BALANCE. accountId comes from get_cash; amount is a positive decimal string, " +
      "the direction comes only from type." +
      AWAITS,
    schema: CashEntry,
    propose: (input) => proposeCashEntry(db, userId, input),
  },
  {
    name: "propose_target_allocation",
    description:
      "Proposes replacing the target allocation on one dimension. Each key comes from " +
      "get_drift for that dimension; the percentages must add up to exactly 100." +
      AWAITS,
    schema: TargetAllocationInput,
    propose: (input) => proposeTargets(db, userId, input),
  },
  {
    name: "propose_price_source",
    description:
      "Proposes an instrument's price source: yahoo (sourceKey is the ticker), page " +
      "(sourceKey is the URL) or manual, with its quotation currency. id comes from " +
      "get_instruments. A changed currency deletes the stored prices." +
      AWAITS,
    schema: InstrumentEdit,
    propose: (input) => proposePriceSource(db, userId, input),
  },
];

import type { Currency, FxRate, Money, Quantity } from "./money.ts";

export type IsoDate = string;

/** The types a bank statement row can have. */
export const BANK_ROW_TYPES = ["DEPOSIT", "WITHDRAWAL", "INTEREST"] as const;

export type TransactionType =
  | "BUY"
  | "SELL"
  | "DIVIDEND"
  | "FEE"
  | "INTEREST"
  | "DEPOSIT"
  | "WITHDRAWAL"
  | "SPLIT"
  | "TRANSFER_IN"
  | "TRANSFER_OUT"
  // What an account held when its history begins; not a deposit, so no contribution to returns.
  | "OPENING_BALANCE";

export type InstrumentKind = "stock" | "etf" | "fund" | "cash";

export type PriceSourceId = "yahoo" | "page" | "manual";

export type Instrument = {
  readonly id: number;
  readonly isin: string | null;
  readonly ticker: string | null;
  readonly name: string;
  readonly kind: InstrumentKind;
  readonly currency: Currency;
  readonly priceSource: PriceSourceId;
  readonly sourceKey: string;
};

export type Txn = {
  readonly id: number;
  readonly accountId: number;
  readonly instrumentId: number | null;
  readonly type: TransactionType;
  readonly tradeDate: IsoDate;
  readonly quantity: Quantity;
  readonly unitPrice: Money | null;
  /** Cash that moved, fee included (a purchase's full debit, a sale's credit after fee). Never add or remove `fee` again. */
  readonly amount: Money;
  /** Reporting only; already in `amount`. */
  readonly fee: Money;
  readonly tax: Money;
  readonly currency: Currency;
  readonly fxRateEur: FxRate;
  /** The source's own text for the row (broker text, or bank label/counterparty/message). Evidence only; `core` never parses it. */
  readonly note?: string | null;
};

export type CashFlow = { readonly date: IsoDate; readonly amountEur: Money };

import type { Currency, FxRate, Money, Quantity } from "./money";

export type IsoDate = string;

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
  | "TRANSFER_OUT";

export type InstrumentKind = "stock" | "etf" | "fund" | "cash";

export type PriceSourceId =
  | "yahoo"
  | "nordnet_fund"
  | "op_fund"
  | "spankki_fund"
  | "danske_fund"
  | "manual";

export type Instrument = {
  readonly id: number;
  readonly isin: string;
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
  readonly amount: Money;
  readonly fee: Money;
  readonly tax: Money;
  readonly currency: Currency;
  readonly fxRateEur: FxRate;
};

export type CashFlow = { readonly date: IsoDate; readonly amountEur: Money };

export type PricePoint = { readonly date: IsoDate; readonly close: Money };

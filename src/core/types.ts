import type { Currency, FxRate, Money, Quantity } from "./money.ts";

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
  | "TRANSFER_OUT"
  /**
   * What an account already held when its recorded history begins. Without it a
   * derived balance is only "everything since the export starts", quietly wrong.
   *
   * Its own type rather than a deposit: a deposit is money arriving from outside,
   * which is what a money-weighted return counts, and this is not a contribution.
   */
  | "OPENING_BALANCE";

export type InstrumentKind = "stock" | "etf" | "fund" | "cash";

export type PriceSourceId = "yahoo" | "nordnet_fund" | "op_fund" | "page" | "manual";

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
  /**
   * The cash that moved, fee included: a purchase's full debit, a sale's credit
   * after the fee. Deliberate -- the ledger sums this directly as the account's
   * movement, and both importers hand over a fee-inclusive total with no
   * fee-exclusive figure anywhere upstream.
   *
   * `fee` rides along for reporting only. It must never be added to or taken off
   * this again downstream.
   */
  readonly amount: Money;
  /** Informational only -- already included in `amount`. See `amount`'s doc. */
  readonly fee: Money;
  readonly tax: Money;
  readonly currency: Currency;
  readonly fxRateEur: FxRate;
  /**
   * What the source called this row: a broker's own text, or a bank's label,
   * counterparty and message joined. Null for a row nobody wrote one for.
   * Never parsed for meaning by `core` -- it is evidence for a reader, and the
   * material the spending view groups by.
   */
  readonly note?: string | null;
};

export type CashFlow = { readonly date: IsoDate; readonly amountEur: Money };

export type PricePoint = { readonly date: IsoDate; readonly close: Money };

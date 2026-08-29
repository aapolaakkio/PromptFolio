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
  | "TRANSFER_OUT"
  /**
   * The balance an account already held when its recorded history begins.
   *
   * A bank statement reaches back a year or two, not to the account's opening,
   * so without this the derived balance is only "everything since the export
   * starts" -- wrong, and wrong quietly. Deliberately its own type rather than
   * a DEPOSIT: a deposit is money arriving from outside, which is what the
   * money-weighted return measures contributions by, and an opening balance is
   * not a contribution. Kept out of every cash-flow definition for that reason.
   */
  | "OPENING_BALANCE";

export type InstrumentKind = "stock" | "etf" | "fund" | "cash";

export type PriceSourceId = "yahoo" | "nordnet_fund" | "op_fund" | "manual";

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
   * The total cash that moved on this transaction, in `currency`, **inclusive of
   * `fee`** -- e.g. a BUY's `amount` is the full amount debited from the account,
   * fee and all; a SELL's `amount` is the full amount credited, fee already
   * deducted. This is deliberate, not incidental: `core/ledger.ts`'s `cashAt` sums
   * `amount` directly as the account's cash movement, and both real importers
   * (`op-paste.ts`'s `Yhteensä`, Nordnet's `Summa`, verified against real fixtures
   * where the running `Saldo` is exactly the cumulative sum of `Summa`) hand it a
   * fee-inclusive total -- there is no fee-exclusive figure anywhere upstream to
   * put here instead. `fee` is carried alongside purely for reporting (a line
   * itemising what was charged); it must never be added to or subtracted from
   * `amount` again downstream (see `core/costbasis.ts`, which derives cost basis
   * and proceeds from `amount` alone for exactly this reason).
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

import { divMoney, EUR, money, type Money } from "../money.ts";

// Finnish tax constants, each with its vero.fi source (read 2026-08-29); rules change, so re-check.
// The 30 % / 34 % capital-income rates are absent on purpose: the bracket depends on income no ledger here sees.

/**
 * Deemed acquisition cost, deductible instead of actual cost: 20 % of the sale price under 10 years
 * of ownership, 40 % from 10 years.
 * https://www.vero.fi/en/individuals/property/investments/selling-shares/
 */
export const DEEMED_COST_SHORT_PERCENT = 20n;
export const DEEMED_COST_LONG_PERCENT = 40n;
export const DEEMED_COST_LONG_YEARS = 10;

/**
 * Sales up to EUR 1,000 per calendar year are untaxed, and that year's losses are then non-deductible.
 * https://www.vero.fi/en/individuals/property/investments/selling-shares/
 */
export const SMALL_SALE_LIMIT_EUR: Money = money(100_000n, EUR);

/**
 * Listed-company dividends: 85 % taxable capital income, 15 % exempt. Withholding is stored per
 * payment in `transactions.tax`.
 * https://www.vero.fi/en/individuals/property/investments/dividends/dividends-from-a-listed-company/
 */
export const DIVIDEND_TAXABLE_PERCENT = 85n;

/**
 * Unused sales losses carry forward 5 years.
 * https://www.vero.fi/en/individuals/property/investments/selling-shares/
 */
export const LOSS_CARRY_YEARS = 5;

/**
 * Equity savings account (OST) cap: EUR 100,000; the non-profit part of a withdrawal frees room.
 * https://www.vero.fi/en/individuals/property/investments/equity-savings-account/
 */
export const OST_DEPOSIT_CAP_EUR: Money = money(10_000_000n, EUR);

/** Integer percentage, half-up to the cent; never a float, the rounding is a tax figure. */
export const percentOf = (m: Money, percent: bigint): Money =>
  divMoney(money(m.minor * percent, m.currency), 100n, "half-up");

import { divMoney, EUR, money, type Money } from "../money.ts";

/**
 * The Finnish rules this module applies, as constants with their provenance.
 *
 * Every figure here was read from vero.fi on 2026-08-29 and is cited below. A
 * tax rule changes without warning, and a constant whose source is not written
 * down cannot be re-checked -- the OST cap had already moved from 50 000 € to
 * 100 000 € before this module was written, and nothing in the codebase would
 * have caught it.
 *
 * Deliberately absent: the 30 % / 34 % capital-income rates. This module reports
 * taxable income, never tax owed, because the bracket depends on the owner's
 * total capital income including income no ledger here can see. See the phase 4
 * spec §2.
 */

/**
 * Hankintameno-olettama, the deemed acquisition cost: a share of the sale price
 * a taxpayer may deduct instead of the actual cost, whichever is better for
 * them.
 *
 * "If you have owned the shares for less than 10 years, the deemed acquisition
 * cost is 20% of the selling price" / "at least 10 years ... 40%".
 * https://www.vero.fi/en/individuals/property/investments/selling-shares/
 */
export const DEEMED_COST_SHORT_PERCENT = 20n;
export const DEEMED_COST_LONG_PERCENT = 40n;
export const DEEMED_COST_LONG_YEARS = 10;

/**
 * "If you have sold shares during the calendar year for a total of EUR 1,000 at
 * maximum, you do not have to pay taxes on the sales profit." The same
 * threshold makes that year's losses non-deductible.
 * https://www.vero.fi/en/individuals/property/investments/selling-shares/
 */
export const SMALL_SALE_LIMIT_EUR: Money = money(100_000n, EUR);

/**
 * "85% is taxable capital income ... 15% is tax-exempt income" for a dividend
 * from a publicly listed company. (The payer withholds 25.5 % at source; what
 * was actually withheld is stored per payment in `transactions.tax`, so no
 * constant is needed for it.)
 * https://www.vero.fi/en/individuals/property/investments/dividends/dividends-from-a-listed-company/
 */
export const DIVIDEND_TAXABLE_PERCENT = 85n;

/**
 * "If you have no capital income or if said income is lower than the sales
 * losses to be deducted, the deduction is transferred to the following 5
 * years."
 * https://www.vero.fi/en/individuals/property/investments/selling-shares/
 */
export const LOSS_CARRY_YEARS = 5;

/**
 * "You can invest a maximum of EUR 100,000 on an equity savings account."
 * Withdrawals free room: the part of a withdrawal that is not profit reduces
 * the total cash payments counted against this cap.
 * https://www.vero.fi/en/individuals/property/investments/equity-savings-account/
 */
export const OST_DEPOSIT_CAP_EUR: Money = money(10_000_000n, EUR);

/**
 * A percentage of an amount, in integers, rounded half-up to the cent. Never a
 * float: 20 % of 12,34 € is 2,468, and the rounding of that third decimal is a
 * tax figure, not a display detail.
 */
export const percentOf = (m: Money, percent: bigint): Money =>
  divMoney(money(m.minor * percent, m.currency), 100n, "half-up");

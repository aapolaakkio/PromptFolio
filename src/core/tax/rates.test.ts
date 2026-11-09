import { describe, expect, test } from "vitest";

import { EUR, formatMoney, parseMoney } from "../money.ts";
import {
  DEEMED_COST_LONG_PERCENT,
  DEEMED_COST_SHORT_PERCENT,
  DIVIDEND_TAXABLE_PERCENT,
  OST_DEPOSIT_CAP_EUR,
  percentOf,
  SMALL_SALE_LIMIT_EUR,
} from "./rates.ts";

describe("percentOf", () => {
  test("rounds half-up to the cent, in integers", () => {
    // 20 % of 12,34 € is 2,468: the third decimal must round half-up.
    expect(formatMoney(percentOf(parseMoney("12,34", EUR), 20n))).toBe("2.47");
  });

  test("rounds a negative amount by magnitude, not toward zero", () => {
    expect(formatMoney(percentOf(parseMoney("-12,34", EUR), 20n))).toBe("-2.47");
  });

  test("is exact on figures that divide cleanly", () => {
    expect(formatMoney(percentOf(parseMoney("1000,00", EUR), DEEMED_COST_LONG_PERCENT))).toBe(
      "400.00",
    );
    expect(formatMoney(percentOf(parseMoney("1000,00", EUR), DEEMED_COST_SHORT_PERCENT))).toBe(
      "200.00",
    );
    expect(formatMoney(percentOf(parseMoney("100,00", EUR), DIVIDEND_TAXABLE_PERCENT))).toBe(
      "85.00",
    );
  });
});

describe("the limits", () => {
  test("are the figures vero.fi states", () => {
    expect(formatMoney(SMALL_SALE_LIMIT_EUR)).toBe("1000.00");
    expect(formatMoney(OST_DEPOSIT_CAP_EUR)).toBe("100000.00");
  });
});

import { describe, expect, test } from "vitest";

import { currencyNote, paidInText } from "./forecast-view.ts";

describe("forecast view", () => {
  test("the paid-in line keeps today's holdings and new money apart", () => {
    expect(paidInText(250, 10_877.56)).toBe(
      "of which today's holdings €250.00 and new money €10,877.56",
    );
  });

  test("the currency note names only non-euro holdings", () => {
    expect(currencyNote([{ name: "Fund", currency: "EUR" }])).toBeNull();
    expect(
      currencyNote([
        { name: "Fund", currency: "EUR" },
        { name: "Apple", currency: "USD" },
        { name: "Volvo", currency: "SEK" },
      ]),
    ).toBe(
      "Growth is measured in each instrument's own currency; exchange-rate moves are not included (Apple in USD, Volvo in SEK).",
    );
  });
});

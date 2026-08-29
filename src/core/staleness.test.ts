import { describe, expect, test } from "bun:test";

import { isPriceStale, previousWeekday } from "./staleness";

// 2026-08-28 is a Friday, 2026-08-29 a Saturday, 2026-08-31 a Monday.
const FRIDAY = "2026-08-28";
const SATURDAY = "2026-08-29";
const SUNDAY = "2026-08-30";
const MONDAY = "2026-08-31";
const TUESDAY = "2026-09-01";

describe("previousWeekday", () => {
  test("steps over the weekend from a Monday", () => {
    expect(previousWeekday(MONDAY)).toBe(FRIDAY);
  });

  test("is the day before on a midweek day", () => {
    expect(previousWeekday(TUESDAY)).toBe(MONDAY);
  });

  test("walks back out of the weekend itself", () => {
    expect(previousWeekday(SUNDAY)).toBe(FRIDAY);
  });
});

describe("isPriceStale", () => {
  test("no price at all is stale whatever the day", () => {
    expect(isPriceStale({ kind: "etf", priceDate: null, on: SATURDAY })).toBe(true);
  });

  test("Friday's close is current at the weekend, because nothing traded since", () => {
    // Badging it "vanha" every weekend trains the user to ignore the badge.
    expect(isPriceStale({ kind: "etf", priceDate: FRIDAY, on: SATURDAY })).toBe(false);
    expect(isPriceStale({ kind: "fund", priceDate: FRIDAY, on: SUNDAY })).toBe(false);
  });

  test("a months-old price is still late at the weekend", () => {
    // The weekend is not a blanket exemption: it moves the expected date back
    // to Friday, it does not stop the comparison happening. An earlier version
    // of this rule returned false for any weekend, which made a price carried
    // forward from January read as current every Saturday.
    expect(isPriceStale({ kind: "etf", priceDate: "2026-01-09", on: SATURDAY })).toBe(true);
    expect(isPriceStale({ kind: "fund", priceDate: "2026-01-09", on: SUNDAY })).toBe(true);
  });

  describe("shares and ETFs", () => {
    test("want today's close on a weekday", () => {
      expect(isPriceStale({ kind: "etf", priceDate: MONDAY, on: MONDAY })).toBe(false);
      expect(isPriceStale({ kind: "stock", priceDate: FRIDAY, on: MONDAY })).toBe(true);
    });
  });

  describe("funds", () => {
    test("are allowed the previous weekday, because the NAV publishes a day late", () => {
      expect(isPriceStale({ kind: "fund", priceDate: FRIDAY, on: MONDAY })).toBe(false);
      expect(isPriceStale({ kind: "fund", priceDate: MONDAY, on: MONDAY })).toBe(false);
    });

    test("are stale once even that day has passed", () => {
      expect(isPriceStale({ kind: "fund", priceDate: FRIDAY, on: TUESDAY })).toBe(true);
    });
  });
});

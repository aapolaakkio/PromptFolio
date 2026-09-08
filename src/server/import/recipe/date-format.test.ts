import { describe, expect, test } from "vitest";

import { readDate } from "./date-format.ts";

describe("readDate", () => {
  test("reads a Finnish date with single-digit parts", () => {
    expect(readDate("1.8.2026", "d.m.yyyy")).toBe("2026-08-01");
  });

  test("reads a zero-padded Finnish date", () => {
    expect(readDate("01.08.2026", "dd.mm.yyyy")).toBe("2026-08-01");
  });

  test("reads an ISO date unchanged", () => {
    expect(readDate("2026-08-01", "yyyy-mm-dd")).toBe("2026-08-01");
  });

  test("takes the year from the hint when the statement prints none", () => {
    expect(readDate("1.8.", "d.m.", "2026")).toBe("2026-08-01");
  });

  test("refuses a day the calendar does not have", () => {
    expect(() => readDate("32.1.2026", "d.m.yyyy")).toThrow(/ei ole olemassa/);
  });

  test("refuses text that is not a date at all", () => {
    expect(() => readDate("K-MARKET", "d.m.yyyy")).toThrow();
  });

  test("refuses a yearless date with no hint", () => {
    expect(() => readDate("1.8.", "d.m.")).toThrow();
  });
});

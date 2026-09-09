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

// A statement prints its dates however its bank likes. The format names an
// ORDER; the separator, the year's width and a spelled-out month are read as
// they come, so one enum member covers a family of layouts.
describe("the shapes one order accepts", () => {
  const dmy = "d.m.yyyy" as const;

  test.each([
    ["8.8.2026", dmy],
    ["08/08/2026", dmy],
    ["8-8-2026", dmy],
    ["8 Aug 2026", dmy],
    ["08 elokuuta 2026", dmy],
  ])("reads %s as day-first", (text, format) => {
    expect(readDate(text, format)).toBe("2026-08-08");
  });

  test("reads a two-digit year in this century", () => {
    expect(readDate("8.8.26", dmy)).toBe("2026-08-08");
  });

  test("reads a two-digit year from the last century", () => {
    expect(readDate("8.8.98", dmy)).toBe("1998-08-08");
  });

  test("reads a month-first date", () => {
    expect(readDate("8/9/2026", "m.d.yyyy")).toBe("2026-08-09");
  });

  test("reads a spelled-out month-first date", () => {
    expect(readDate("Aug 8, 2026", "m.d.yyyy")).toBe("2026-08-08");
  });

  test("refuses a month name it does not know", () => {
    expect(() => readDate("8 Elokuu-ish 2026", dmy)).toThrow(/ei kelpaa/);
  });
});

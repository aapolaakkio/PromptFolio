import { describe, expect, test } from "vitest";

import { helsinkiToday, shiftDay } from "./helsinki.ts";
import { isoWeek } from "./service.ts";

describe("Helsinki days", () => {
  test("Monday 00:30 in Helsinki is Monday, already the new week", () => {
    const sundayNightUtc = new Date(Date.UTC(2026, 10, 8, 22, 30));
    expect(helsinkiToday(sundayNightUtc)).toBe("2026-11-09");
    expect(isoWeek(sundayNightUtc)).toBe("2026-W46");
  });
  test("summer time is three hours ahead", () => {
    expect(helsinkiToday(new Date(Date.UTC(2026, 6, 5, 21, 30)))).toBe("2026-07-06");
  });
  test("shiftDay moves calendar days", () => {
    expect(shiftDay("2026-03-01", -1)).toBe("2026-02-28");
  });
});

import { expect, test } from "vitest";

import { isOpen } from "./market-hours.ts";

test("Helsinki 18:29 local is open, 18:31 is not, in summer and in winter", () => {
  expect(isOpen("NOKIA.HE", new Date("2026-07-01T15:29Z"))).toBe(true);
  expect(isOpen("NOKIA.HE", new Date("2026-07-01T15:31Z"))).toBe(false);
  expect(isOpen("NOKIA.HE", new Date("2026-01-15T16:29Z"))).toBe(true);
  expect(isOpen("NOKIA.HE", new Date("2026-01-15T16:31Z"))).toBe(false);
});

test("Helsinki opens at 10:00 local", () => {
  expect(isOpen("NOKIA.HE", new Date("2026-07-01T06:59Z"))).toBe(false);
  expect(isOpen("NOKIA.HE", new Date("2026-07-01T07:00Z"))).toBe(true);
});

test("Saturday is never open", () => {
  // 2026-07-04 is a Saturday; midday everywhere listed.
  for (const symbol of ["NOKIA.HE", "SAP.DE", "VOLV-B.ST", "AAPL", "IWDA.AS"]) {
    expect(isOpen(symbol, new Date("2026-07-04T12:00Z"))).toBe(false);
  }
});

test("a US symbol follows New York hours", () => {
  // 09:30-16:00 America/New_York; EDT is UTC-4 on 2026-07-01.
  expect(isOpen("AAPL", new Date("2026-07-01T13:29Z"))).toBe(false);
  expect(isOpen("AAPL", new Date("2026-07-01T13:31Z"))).toBe(true);
  expect(isOpen("AAPL", new Date("2026-07-01T19:59Z"))).toBe(true);
  expect(isOpen("AAPL", new Date("2026-07-01T20:01Z"))).toBe(false);
});

test("Stockholm and Xetra keep 09:00-17:30 local, and an unknown suffix follows Xetra", () => {
  // CEST is UTC+2 on 2026-07-01.
  for (const symbol of ["SAP.DE", "VOLV-B.ST", "IWDA.AS"]) {
    expect(isOpen(symbol, new Date("2026-07-01T06:59Z"))).toBe(false);
    expect(isOpen(symbol, new Date("2026-07-01T07:01Z"))).toBe(true);
    expect(isOpen(symbol, new Date("2026-07-01T15:29Z"))).toBe(true);
    expect(isOpen(symbol, new Date("2026-07-01T15:31Z"))).toBe(false);
  }
});

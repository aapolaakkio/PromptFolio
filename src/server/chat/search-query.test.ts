import { describe, expect, test } from "vitest";

import { isPersonalQuery } from "./search-query.ts";

const OWNER = "Maija Meikäläinen";

describe("isPersonalQuery", () => {
  test.each([
    ["an IBAN", "FI21 1234 5600 0007 85 balance"],
    ["a Finnish personal identity code", "verokortti 010190-123A"],
    ["an email address", "maija.meikalainen@example.com osakkeet"],
    ["the owner's name", "Maija Meikäläinen osinko 2025"],
    ["the owner's name, surname first", "meikäläinen maija verotus"],
    ["a card number", "4111 1111 1111 1111 refund"],
    ["a phone number", "soita +358401234567"],
    ["a value hidden from the model", "osinko tilille FI…"],
  ])("flags %s", (_what, query) => {
    expect(isPersonalQuery(query, OWNER)).toBe(true);
  });

  test.each([
    ["an ISIN", "FI0009000681 tender offer price"],
    ["a ticker", "NOKIA.HE close 2024-03-15"],
    ["a date", "Seligson Suomi Indeksirahasto NAV 2023-12-29"],
    ["an instrument name", "Fortum Oyj delisted share price"],
    ["a tax term", "vero.fi luovutusvoiton verotus hankintameno-olettama"],
    ["one part of the owner's name alone", "Maija fund fee"],
  ])("does not flag %s", (_what, query) => {
    expect(isPersonalQuery(query, OWNER)).toBe(false);
  });

  test("without a known owner name, only the patterns count", () => {
    expect(isPersonalQuery("Maija Meikäläinen", null)).toBe(false);
    expect(isPersonalQuery("FI21 1234 5600 0007 85", null)).toBe(true);
  });
});

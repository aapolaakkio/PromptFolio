import { describe, expect, test } from "vitest";

import { matchesBank, OP_BANK, OP_CREDIT, parseBankStatement } from "./bank-statement.ts";

/** OP's credit card log: the real header, and rows shaped like the real ones. */
const CARD_CSV = [
  '"Kirjauspäivä";"Arvopäivä";"Määrä";"Kurssi";"Selite";"Maksaja";"Saaja";"Arkistointitunnus"',
  '"2026-08-27";"2026-08-28";-23.82;"EUR";"ESIMERKKI ENERGIA";"MAKSAJA NIMI";"ESIMERKKI ENERGIA";"10000000000000000000001"',
  '"2026-06-25";"2026-06-26";456.11;"EUR";"Suoritus";"";"";"202601011AAA00000001"',
].join("\r\n");

// SAFETY: `TextEncoder.encode` returns a fresh Uint8Array over a plain
// ArrayBuffer -- never a SharedArrayBuffer, which is the only other thing
// `.buffer` can be.
const bytes = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer;

describe("OP_CREDIT", () => {
  test("is told apart from the account statement by its own headers", () => {
    expect(matchesBank(bytes(CARD_CSV), OP_CREDIT)).toBe(true);
    // The account statement has no `Kurssi` and no `Arvopäivä`, so a card log
    // can never be read as one, whichever is tried first.
    expect(matchesBank(bytes(CARD_CSV), OP_BANK)).toBe(false);
  });

  test("reads a purchase, decimal point and all", () => {
    // The card log writes -23.82 where the account statement writes -23,82.
    const { rows, problems } = parseBankStatement(bytes(CARD_CSV), OP_CREDIT);

    expect(problems).toEqual([]);
    const purchase = rows.find((row) => row.counterparty === "ESIMERKKI ENERGIA");
    expect(purchase?.amount).toBe(-2382n);
    expect(purchase?.type).toBe("WITHDRAWAL");
    // The note is what the spending rules match on, so the shop's name has to
    // reach it.
    expect(purchase?.note).toContain("ESIMERKKI ENERGIA");
  });

  test("reads a settlement as money arriving on the card", () => {
    // The credit side of the monthly bill. Its debit sits on an ordinary
    // account, and `spending/internal.ts` pairs the two -- which is what stops
    // the purchases and the bill that settles them both counting as spending.
    const { rows } = parseBankStatement(bytes(CARD_CSV), OP_CREDIT);
    const settlement = rows.find((row) => row.note === "Suoritus");

    expect(settlement?.amount).toBe(45611n);
    expect(settlement?.type).toBe("DEPOSIT");
  });

  test("keeps the archive id, so a re-imported period does not double a month", () => {
    const { rows } = parseBankStatement(bytes(CARD_CSV), OP_CREDIT);
    expect(rows[0]?.externalId).toBe("10000000000000000000001");
  });
});

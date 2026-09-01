import { describe, expect, test } from "vitest";

import type { BankRow } from "./bank-statement.ts";
import {
  BankDraft,
  bankDraftFromReading,
  bankDraftFromRows,
  bankRowsFromDraft,
  checkBankDraft,
} from "./bank-draft.ts";

const reading = {
  from: "2025-08-28",
  to: "2026-08-28",
  openingBalance: "1500,00",
  closingBalance: "3236.44",
  maturityDate: null,
  rows: [
    {
      date: "2025-09-01",
      amount: "-25.90",
      counterparty: "K-MARKET",
      message: "",
      reference: "A1",
    },
    {
      date: "2025-09-02",
      amount: "2750.00",
      counterparty: "TYÖNANTAJA",
      message: "PALKKA",
      reference: null,
    },
    { date: "2026-08-01", amount: "12.34", counterparty: "", message: "KORKO", reference: null },
  ],
  problems: [{ line: 9, text: "epäselvä rivi" }],
};

describe("bankDraftFromReading", () => {
  test("carries the statement, normalises the decimal comma, and types rows by sign or by 'korko'", () => {
    const draft = bankDraftFromReading(reading);
    expect(draft.statement).toEqual({
      from: "2025-08-28",
      to: "2026-08-28",
      openingBalanceEur: "1500.00",
      closingBalanceEur: "3236.44",
      maturityDate: null,
    });
    expect(draft.rows.map((row) => row.type)).toEqual(["WITHDRAWAL", "DEPOSIT", "INTEREST"]);
    expect(draft.rows[0]).toMatchObject({ line: 1, amountEur: "-25.90", externalId: "A1" });
    expect(draft.problems).toEqual([{ line: 9, text: "epäselvä rivi" }]);
  });
});

describe("checkBankDraft", () => {
  test("agrees when the rows account for the closing balance", () => {
    const draft = bankDraftFromReading({ ...reading, closingBalance: "4236.44" });
    expect(checkBankDraft(draft)).toEqual({ ok: true, differenceEur: "0.00" });
  });

  test("reports the difference otherwise, and is null for a CSV draft", () => {
    expect(checkBankDraft(bankDraftFromReading(reading))).toEqual({
      ok: false,
      differenceEur: "-1000.00",
    });
    expect(checkBankDraft(bankDraftFromRows([], []))).toBeNull();
  });
});

describe("bankRowsFromDraft", () => {
  test("round-trips through BankRow, with the note the ledger stores", () => {
    const rows = bankRowsFromDraft(bankDraftFromReading(reading));
    expect(rows[0]).toMatchObject({
      amount: -2590n,
      note: "K-MARKET",
      externalId: "A1",
    });
    expect(rows[2]?.note).toBe("KORKO");
  });

  test("refuses a hand-edited amount that is not a number, naming the row", () => {
    const draft = BankDraft.parse({
      statement: null,
      rows: [
        {
          line: 4,
          date: "2025-01-01",
          type: "DEPOSIT",
          amountEur: "paljon",
          counterparty: "",
          label: "",
          message: "",
          externalId: null,
        },
      ],
      problems: [],
    });
    expect(() => bankRowsFromDraft(draft)).toThrow(/Rivi 4/);
  });
});

// `bank-statement.ts`'s own note format, reproduced here so a test failure
// points at the round trip rather than a copy of its private `noteOf`.
const csvNote = (label: string, counterparty: string, message: string): string =>
  [label, counterparty, message]
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .join(" — ");

const bankRow = (note: string, counterparty: string): BankRow => ({
  line: 1,
  date: "2025-09-01",
  type: "WITHDRAWAL",
  amount: -1000n,
  counterparty,
  note,
  externalId: null,
});

describe("bankDraftFromRows then bankRowsFromDraft", () => {
  test.each([
    ["label, counterparty and message all present", "PKORTTIMAKSU", "K-MARKET ESIMERKKI", "OSTOS"],
    ["an empty message", "PKORTTIMAKSU", "K-MARKET ESIMERKKI", ""],
    ["an empty label, the PDF shape", "", "K-MARKET ESIMERKKI", "OSTOS"],
  ])("round-trips a note with %s", (_case, label, counterparty, message) => {
    const note = csvNote(label, counterparty, message);
    const draft = bankDraftFromRows([bankRow(note, counterparty)], []);
    const rows = bankRowsFromDraft(draft);
    expect(rows[0]?.note).toBe(note);
  });
});

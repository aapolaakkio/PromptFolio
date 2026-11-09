import { describe, expect, test } from "vitest";

import { EUR, money } from "../../core/money.ts";
import type { PdfStatement } from "./bank-pdf.ts";
import type { BankRow } from "./bank-statement.ts";
import {
  BankDraft,
  bankDraftFromRows,
  bankDraftFromStatement,
  bankRowsFromDraft,
  checkBankDraft,
} from "./bank-draft.ts";

const statement: PdfStatement = {
  from: "2025-08-28",
  to: "2026-08-28",
  openingBalance: money(150_000n, EUR),
  closingBalance: money(323_644n, EUR),
  maturityDate: null,
  rows: [
    {
      line: 1,
      date: "2025-09-01",
      type: "WITHDRAWAL",
      amount: -2590n,
      counterparty: "K-MARKET",
      note: "K-MARKET",
      externalId: "A1",
    },
    {
      line: 2,
      date: "2025-09-02",
      type: "DEPOSIT",
      amount: 275_000n,
      counterparty: "TYÖNANTAJA",
      note: "TYÖNANTAJA — PALKKA",
      externalId: null,
    },
    {
      line: 3,
      date: "2026-08-01",
      type: "INTEREST",
      amount: 1234n,
      counterparty: "",
      note: "KORKO",
      externalId: null,
    },
  ],
  problems: [{ line: 9, message: "unclear row" }],
};

const draftOf = (overrides: Partial<PdfStatement> = {}) =>
  bankDraftFromStatement({ ...statement, ...overrides }, []);

describe("bankDraftFromStatement", () => {
  test("carries the statement's own balances and each row's type", () => {
    const draft = draftOf();
    expect(draft.statement).toEqual({
      from: "2025-08-28",
      to: "2026-08-28",
      openingBalanceEur: "1500.00",
      closingBalanceEur: "3236.44",
      maturityDate: null,
    });
    expect(draft.rows.map((row) => row.type)).toEqual(["WITHDRAWAL", "DEPOSIT", "INTEREST"]);
    expect(draft.rows[0]).toMatchObject({ line: 1, amountEur: "-25.90", externalId: "A1" });
    expect(draft.rows[1]).toMatchObject({ counterparty: "TYÖNANTAJA", message: "PALKKA" });
    expect(draft.problems).toEqual([{ line: 9, text: "unclear row" }]);
  });

  test("a line nobody could account for becomes a problem the owner sees", () => {
    const draft = bankDraftFromStatement(statement, [{ line: 2, text: "EXAMPLE ASIAKAS" }]);
    expect(draft.problems).toEqual([
      { line: 2, text: "Unrecognised line: EXAMPLE ASIAKAS" },
      { line: 9, text: "unclear row" },
    ]);
  });
});

describe("checkBankDraft", () => {
  test("agrees when the rows account for the closing balance", () => {
    const draft = draftOf({ closingBalance: money(423_644n, EUR) });
    expect(checkBankDraft(draft)).toEqual({ ok: true, differenceEur: "0.00" });
  });

  test("reports the difference otherwise, and is null for a CSV draft", () => {
    expect(checkBankDraft(draftOf())).toEqual({
      ok: false,
      differenceEur: "-1000.00",
    });
    expect(checkBankDraft(bankDraftFromRows([], []))).toBeNull();
  });
});

describe("bankRowsFromDraft", () => {
  test("round-trips through BankRow, with the note the ledger stores", () => {
    const rows = bankRowsFromDraft(draftOf());
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
    expect(() => bankRowsFromDraft(draft)).toThrow(/Row 4/);
  });
});

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
    ["label, counterparty and message all present", "PKORTTIMAKSU", "K-MARKET EXAMPLE", "OSTOS"],
    ["an empty message", "PKORTTIMAKSU", "K-MARKET EXAMPLE", ""],
    ["an empty label, the PDF shape", "", "K-MARKET EXAMPLE", "OSTOS"],
  ])("round-trips a note with %s", (_case, label, counterparty, message) => {
    const note = csvNote(label, counterparty, message);
    const draft = bankDraftFromRows([bankRow(note, counterparty)], []);
    const rows = bankRowsFromDraft(draft);
    expect(rows[0]?.note).toBe(note);
  });
});

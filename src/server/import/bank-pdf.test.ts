import { describe, expect, test } from "bun:test";

import { extractStatementText, parseOpStatementText, verifyStatement } from "./bank-pdf";

// The fixture is the text layer of an OP statement, in the exact shapes a real
// one uses: a unicode minus, a non-breaking thousands separator, an amount that
// therefore splits across two tokens, the counterparty on the following line,
// and the page furniture between them. Verified against a real statement,
// where the printed closing balance was reached to the cent.

const fixture = (): Promise<string> =>
  Bun.file(`${import.meta.dir}/fixtures/op-statement-sample.txt`).text();

describe("parseOpStatementText", () => {
  test("reads the period from the balance lines the statement prints", async () => {
    const statement = parseOpStatementText(await fixture());

    expect(statement.from).toBe("2025-08-28");
    expect(statement.to).toBe("2026-08-28");
    expect(statement.openingBalance.minor).toBe(150_000n);
    expect(statement.closingBalance.minor).toBe(323_644n);
  });

  test("reads every transaction, with its sign", async () => {
    const { rows } = parseOpStatementText(await fixture());

    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.amount)).toEqual([-2590n, 275_000n, -100_000n, 1234n]);
  });

  test("handles the thousands separator that splits an amount into two tokens", async () => {
    const { rows } = parseOpStatementText(await fixture());
    expect(rows[1]?.amount).toBe(275_000n);
  });

  test("takes the counterparty from the line below, past the page furniture", async () => {
    const { rows } = parseOpStatementText(await fixture());

    expect(rows[0]?.counterparty).toBe("K-MARKET ESIMERKKI");
    expect(rows[0]?.note).toBe("PKORTTIMAKSU — K-MARKET ESIMERKKI");
  });

  test("names interest, and decides everything else by sign", async () => {
    const { rows } = parseOpStatementText(await fixture());

    expect(rows.map((row) => row.type)).toEqual([
      "WITHDRAWAL",
      "DEPOSIT",
      "WITHDRAWAL",
      "INTEREST",
    ]);
  });

  test("takes the archive id, not the payment reference, as the row's identity", async () => {
    const { rows } = parseOpStatementText(await fixture());

    // The card payment's line carries a receipt number before the archive id.
    expect(rows[0]?.externalId).toBe("20250829ESIM00000001");
    expect(rows[1]?.externalId).toBe("20250901ESIM00000002");
    expect(new Set(rows.map((row) => row.externalId)).size).toBe(rows.length);
  });

  test("refuses a document with no balance lines rather than importing rows alone", () => {
    expect(() =>
      parseOpStatementText("29.8.2025 −13,61 PKORTTIMAKSU 1 202508 J\nKAUPPA\n"),
    ).toThrow(/alku- ja loppusaldoa/);
  });
});

describe("verifyStatement", () => {
  test("confirms the rows account for the balance the bank printed", async () => {
    const statement = parseOpStatementText(await fixture());
    const result = verifyStatement(statement);

    // 1500,00 - 25,90 + 2750,00 - 1000,00 + 12,34 = 3236,44
    expect(result.ok).toBe(true);
    expect(result.differenceEur).toBe(0n);
  });

  test("reports the gap when a row is missing, rather than letting it through", async () => {
    const statement = parseOpStatementText(await fixture());
    const missingOne = { ...statement, rows: statement.rows.slice(1) };

    const result = verifyStatement(missingOne);
    expect(result.ok).toBe(false);
    // The dropped row was -25,90, so the ledger would come out that much high.
    expect(result.differenceEur).toBe(-2590n);
  });
});

describe("extractStatementText", () => {
  const pdf = (name: string): Promise<ArrayBuffer> =>
    Bun.file(`${import.meta.dir}/fixtures/${name}`).arrayBuffer();

  test("reads a real PDF's text layer, balances and all", async () => {
    const text = await extractStatementText(await pdf("op-statement-sample.pdf"));
    const statement = parseOpStatementText(text);

    expect(statement.rows).toHaveLength(2);
    expect(verifyStatement(statement).ok).toBe(true);
  });

  test("refuses a scan rather than reporting a statement with no transactions", async () => {
    // A PDF with no text layer parses to nothing, which would otherwise look
    // exactly like a statement covering a quiet month.
    expect(extractStatementText(await pdf("scanned-no-text.pdf"))).rejects.toThrow(
      /ei sisällä tekstiä/,
    );
  });
});

describe("a row the parser cannot read", () => {
  test("is reported as a problem instead of stopping the statement", () => {
    const text = [
      "+100,00 Saldo 1.1.2026",
      "32.13.2026 −10,00 PKORTTIMAKSU 1 202601015UTZ00000001 J",
      "KAUPPA",
      "+90,00 Saldo 31.1.2026",
    ].join("\n");

    const statement = parseOpStatementText(text);
    // The date does not exist, so the row is reported rather than stored as
    // "2026-13-32", which would sort and filter wrongly everywhere downstream.
    expect(statement.rows).toHaveLength(0);
    expect(statement.problems).toHaveLength(1);
    expect(statement.problems[0]?.message).toContain("ei ole olemassa");
  });
});

describe("a fixed-term deposit's statement", () => {
  const fixedTerm = (): Promise<string> =>
    Bun.file(`${import.meta.dir}/fixtures/op-fixed-term-sample.txt`).text();

  test("reads balances that carry no sign", async () => {
    const statement = parseOpStatementText(await fixedTerm());

    // An account opened during the period starts at a bare "0,00", with no "+".
    // Requiring the sign refused a real statement as "not an OP statement".
    expect(statement.openingBalance.minor).toBe(0n);
    expect(statement.closingBalance.minor).toBe(500_000n);
  });

  test("finds the archive id below the row, where this layout puts it", async () => {
    const { rows } = parseOpStatementText(await fixedTerm());

    expect(rows).toHaveLength(1);
    expect(rows[0]?.externalId).toBe("20260201ESIM00000004");
    expect(rows[0]?.amount).toBe(500_000n);
  });

  test("reads the maturity date the deposit prints", async () => {
    expect(parseOpStatementText(await fixedTerm()).maturityDate).toBe("2027-02-01");
  });

  test("is not confused by the deposit and withdrawal totals into extra rows", async () => {
    // "5 000,00 Panot yhteensä 1 kpl" is a summary, not a transaction: it
    // carries an amount but no date, so it must not be read as one.
    const { rows } = parseOpStatementText(await fixedTerm());
    expect(rows).toHaveLength(1);
    expect(verifyStatement(parseOpStatementText(await fixedTerm())).ok).toBe(true);
  });

  test("a current account's statement still has no maturity date", async () => {
    expect(parseOpStatementText(await fixture()).maturityDate).toBeNull();
  });
});

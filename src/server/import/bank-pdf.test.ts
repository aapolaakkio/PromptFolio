import { readBytes, readText } from "../files.ts";
import { describe, expect, test } from "vitest";

import { extractStatementText, parseOpStatementText, verifyStatement } from "./bank-pdf.ts";

// The fixture is the text layer of an OP statement, in the exact shapes a real
// one uses: a unicode minus, a non-breaking thousands separator, an amount that
// therefore splits across two tokens, the counterparty on the following line,
// and the page furniture between them. Verified against a real statement,
// where the printed closing balance was reached to the cent.

const fixture = (): Promise<string> =>
  readText(`${import.meta.dirname}/fixtures/op-statement-sample.txt`);

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

  test("refuses a document with no balance lines rather than importing rows alone", async () => {
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
    readBytes(`${import.meta.dirname}/fixtures/${name}`);

  test("reads a real PDF's text layer, balances and all", async () => {
    const text = await extractStatementText(await pdf("op-statement-sample.pdf"));
    const statement = parseOpStatementText(text);

    expect(statement.rows).toHaveLength(2);
    expect(verifyStatement(statement).ok).toBe(true);
  });

  test("refuses a scan rather than reporting a statement with no transactions", async () => {
    // A PDF with no text layer parses to nothing, which would otherwise look
    // exactly like a statement covering a quiet month.
    await expect(extractStatementText(await pdf("scanned-no-text.pdf"))).rejects.toThrow(
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
    readText(`${import.meta.dirname}/fixtures/op-fixed-term-sample.txt`);

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

describe("a row continued across a page break", () => {
  test("does not take the statement's own period line as its counterparty", () => {
    // The period sits directly under a page's repeated header, which is where a
    // row broken across pages looks for its counterparty. Seventeen payments in
    // a real statement were filed under a date range as though it were a shop.
    const text = [
      "+100,00 Saldo 1.1.2026",
      "2.1.2026 −10,00 PKORTTIMAKSU 1 202601025UTZ00000001 J",
      "Tiliote",
      "Käyttötili",
      "Ajalta",
      "29.8.2025 - 28.8.2026",
      "2 (5)",
      "OIKEA KAUPPA",
      "+90,00 Saldo 31.1.2026",
    ].join("\n");

    const { rows } = parseOpStatementText(text);
    expect(rows[0]?.counterparty).toBe("OIKEA KAUPPA");
  });
});

describe("a label of more than one word", () => {
  test("is kept whole, so a rule written against it matches", () => {
    // "LUOTON MAKSU" was truncated to "LUOTON", and credit repayments then sat
    // unclassified while a seed rule for them existed.
    const text = [
      "+100,00 Saldo 1.1.2026",
      "2.1.2026 −10,00 LUOTON MAKSU 202601025UTZ00000001 J",
      "PANKKI OYJ",
      "+90,00 Saldo 31.1.2026",
    ].join("\n");

    expect(parseOpStatementText(text).rows[0]?.note).toBe("LUOTON MAKSU — PANKKI OYJ");
  });

  test("stops before the references that follow it", () => {
    const text = [
      "+100,00 Saldo 1.1.2026",
      "2.1.2026 −10,00 PKORTTIMAKSU 782367 202601025EQEO0000001 J",
      "KAUPPA",
      "+90,00 Saldo 31.1.2026",
    ].join("\n");

    expect(parseOpStatementText(text).rows[0]?.note).toBe("PKORTTIMAKSU — KAUPPA");
  });
});

describe("the message a payer wrote", () => {
  test("is kept, since it is often what identifies a bill", () => {
    // A rent payment's payee can be a housing company's account number; the
    // message is where it says what the money was for.
    const text = [
      "+1 000,00 Saldo 1.1.2026",
      "2.1.2026 −300,00 MAKSUPALVELU 20260102000000000001 A",
      "ASUNTO OY ESIMERKKI",
      "Viesti:",
      "VUOKRA 1/2026",
      "+700,00 Saldo 31.1.2026",
    ].join("\n");

    const { rows } = parseOpStatementText(text);
    expect(rows[0]?.note).toBe("MAKSUPALVELU — ASUNTO OY ESIMERKKI — VUOKRA 1/2026");
  });

  test("leaves the card terminal's own noise out of the note", () => {
    const text = [
      "+100,00 Saldo 1.1.2026",
      "2.1.2026 −12,00 PKORTTIMAKSU 782367 202601025EQEO0000001 J",
      "K-MARKET ESIMERKKI",
      "Viesti:",
      "400000******0000 OSTOPVM 260101",
      "MF NRO 00000000000000000000000",
      "VARMENTAJA 400",
      "+88,00 Saldo 31.1.2026",
    ].join("\n");

    // The masked card number and terminal codes say nothing about the purchase
    // and would bury the shop's name beside them.
    expect(parseOpStatementText(text).rows[0]?.note).toBe("PKORTTIMAKSU — K-MARKET ESIMERKKI");
  });
});

describe("a transaction continued across a page break", () => {
  // The real statement puts the payee of a page's last row at the top of the
  // next page, past the footer and the whole repeated header. A dozen payments
  // in a real statement landed that way and lost their payee entirely.
  const acrossPages = [
    "+100,00 Saldo 1.1.2026",
    "Tilinumero FI00 0000 0000 0000 00",
    "2.1.2026 −12,00 PKORTTIMAKSU 12570 202601025EQEO0000001 J",
    "Tiliote",
    "Käyttötili",
    "Ajalta",
    "29.8.2025 - 28.8.2026",
    "82 (87)",
    "Jatkuu",
    "Tilinumero",
    "BIC",
    "FI00 0000 0000 0000 00",
    "OKOYFIHH",
    "Kirjaus-",
    "päivä",
    "Selitys",
    "Maksunsaaja/maksaja",
    "K-SUPERMARKET ESIMERKKI",
    "+88,00 Saldo 31.1.2026",
  ].join("\n");

  test("finds its payee on the far side of the header", () => {
    expect(parseOpStatementText(acrossPages).rows[0]?.note).toBe(
      "PKORTTIMAKSU — K-SUPERMARKET ESIMERKKI",
    );
  });

  test("does not take the page footer or the account's own number as the payee", () => {
    const { rows } = parseOpStatementText(acrossPages);
    expect(rows[0]?.counterparty).not.toBe("Jatkuu");
    expect(rows[0]?.counterparty).not.toContain("FI00");
    expect(rows[0]?.counterparty).not.toBe("OKOYFIHH");
  });

  test("still treats an IBAN in a payee's place as a payee", () => {
    // Only the account's own number is furniture. A transfer to someone the
    // bank did not name is identified by their account number and nothing else.
    const text = [
      "+100,00 Saldo 1.1.2026",
      "Tilinumero FI00 0000 0000 0000 00",
      "2.1.2026 −50,00 TILISIIRTO 20260102000000000001 A",
      "FI11 1111 1111 1111 11",
      "+50,00 Saldo 31.1.2026",
    ].join("\n");

    expect(parseOpStatementText(text).rows[0]?.counterparty).toBe("FI11 1111 1111 1111 11");
  });
});

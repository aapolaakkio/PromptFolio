import { readBytes, readText } from "../files.ts";
import { describe, expect, test } from "vitest";

import { parseOpStatementText, verifyStatement } from "./bank-pdf.ts";
import { extractPages } from "./pdf-read.ts";

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

    expect(rows[0]?.externalId).toBe("20250829ESIM00000001");
    expect(rows[1]?.externalId).toBe("20250901ESIM00000002");
    expect(new Set(rows.map((row) => row.externalId)).size).toBe(rows.length);
  });

  test("refuses a document with no balance lines rather than importing rows alone", async () => {
    expect(() =>
      parseOpStatementText("29.8.2025 −13,61 PKORTTIMAKSU 1 202508 J\nKAUPPA\n"),
    ).toThrow(/opening and closing balance/);
  });
});

describe("verifyStatement", () => {
  test("confirms the rows account for the balance the bank printed", async () => {
    const statement = parseOpStatementText(await fixture());
    const result = verifyStatement(statement);

    expect(result.ok).toBe(true);
    expect(result.differenceEur).toBe(0n);
  });

  test("reports the gap when a row is missing, rather than letting it through", async () => {
    const statement = parseOpStatementText(await fixture());
    const missingOne = { ...statement, rows: statement.rows.slice(1) };

    const result = verifyStatement(missingOne);
    expect(result.ok).toBe(false);
    expect(result.differenceEur).toBe(-2590n);
  });
});

test("a real PDF's text layer reads into a statement that balances", async () => {
  const pages = await extractPages(
    await readBytes(`${import.meta.dirname}/fixtures/op-statement-sample.pdf`),
  );
  const statement = parseOpStatementText(pages.map((page) => page.text).join("\n"));

  expect(statement.rows).toHaveLength(2);
  expect(verifyStatement(statement).ok).toBe(true);
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
    expect(statement.rows).toHaveLength(0);
    expect(statement.problems).toHaveLength(1);
    expect(statement.problems[0]?.message).toContain("does not exist");
  });
});

describe("a fixed-term deposit's statement", () => {
  const fixedTerm = (): Promise<string> =>
    readText(`${import.meta.dirname}/fixtures/op-fixed-term-sample.txt`);

  test("reads balances that carry no sign", async () => {
    const statement = parseOpStatementText(await fixedTerm());

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

    expect(parseOpStatementText(text).rows[0]?.note).toBe("PKORTTIMAKSU — K-MARKET ESIMERKKI");
  });
});

describe("a transaction continued across a page break", () => {
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

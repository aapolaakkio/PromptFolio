import { describe, expect, test } from "vitest";

import { readText } from "../../files.ts";
import { parseOpStatementText, verifyStatement } from "../bank-pdf.ts";
import { OP_STATEMENT_RECIPE } from "./op-reference.ts";
import { runRecipe } from "./run.ts";

const fixture = (name: string): Promise<string> =>
  readText(`${import.meta.dirname}/../fixtures/${name}`);

describe("OP_STATEMENT_RECIPE", () => {
  test("reads the same balances the hand-written parser reads", async () => {
    const text = await fixture("op-statement-sample.txt");
    const { statement } = runRecipe(text, OP_STATEMENT_RECIPE);
    const reference = parseOpStatementText(text);

    expect(statement.from).toBe(reference.from);
    expect(statement.to).toBe(reference.to);
    expect(statement.openingBalance.minor).toBe(reference.openingBalance.minor);
    expect(statement.closingBalance.minor).toBe(reference.closingBalance.minor);
  });

  test("reads the same rows the hand-written parser reads", async () => {
    const text = await fixture("op-statement-sample.txt");
    const { statement } = runRecipe(text, OP_STATEMENT_RECIPE);
    const reference = parseOpStatementText(text);

    expect(statement.rows.map((row) => row.amount)).toEqual(
      reference.rows.map((row) => row.amount),
    );
    expect(statement.rows.map((row) => row.date)).toEqual(reference.rows.map((row) => row.date));
    expect(statement.rows.map((row) => row.counterparty)).toEqual(
      reference.rows.map((row) => row.counterparty),
    );
    expect(statement.rows.map((row) => row.externalId)).toEqual(
      reference.rows.map((row) => row.externalId),
    );
    expect(statement.rows.map((row) => row.type)).toEqual(reference.rows.map((row) => row.type));
  });

  test("its rows add up to the balance the statement prints", async () => {
    const { statement } = runRecipe(await fixture("op-statement-sample.txt"), OP_STATEMENT_RECIPE);
    expect(verifyStatement(statement).ok).toBe(true);
  });

  test("claims every line of the statement", async () => {
    const { unclaimed } = runRecipe(await fixture("op-statement-sample.txt"), OP_STATEMENT_RECIPE);
    expect(unclaimed).toEqual([]);
  });

  test("reads the fixed-term statement and its maturity date", async () => {
    const text = await fixture("op-fixed-term-sample.txt");
    const { statement } = runRecipe(text, OP_STATEMENT_RECIPE);
    const reference = parseOpStatementText(text);

    expect(statement.maturityDate).toBe(reference.maturityDate);
    expect(verifyStatement(statement).ok).toBe(true);
  });

  const synthetic = (payee: string): string =>
    [
      "+0,00 Saldo 1.1.2026",
      "2.1.2026 +100,00 TILISIIRTO 20260102ESIM00000009 J",
      payee,
      "+100,00 Saldo 31.1.2026",
    ].join("\n");

  test("keeps a payee printed as one long unspaced word", () => {
    const { statement, unclaimed } = runRecipe(
      synthetic("KESKINAEINENVAKUUTUSYHTIOE"),
      OP_STATEMENT_RECIPE,
    );

    expect(statement.rows[0]?.counterparty).toBe("KESKINAEINENVAKUUTUSYHTIOE");
    expect(statement.rows[0]?.externalId).toBe("20260102ESIM00000009");
    expect(unclaimed).toEqual([]);
  });

  test("keeps a payee whose name begins with a furniture word", () => {
    const { statement, unclaimed } = runRecipe(synthetic("BIC-ATRIA OY"), OP_STATEMENT_RECIPE);

    expect(statement.rows[0]?.counterparty).toBe("BIC-ATRIA OY");
    expect(unclaimed).toEqual([]);
  });
});

import { describe, expect, test } from "vitest";

import { readText } from "../../files.ts";
import { OP_STATEMENT_RECIPE } from "./op-reference.ts";
import type { BankRecipe } from "./types.ts";
import { createVerifySession, VERIFY_TOOL_NAME, verifyToolDefinition } from "./verify-tool.ts";

const fixture = (): Promise<string> =>
  readText(`${import.meta.dirname}/../fixtures/op-statement-sample.txt`);

const wrongSign: BankRecipe = {
  ...OP_STATEMENT_RECIPE,
  money: { ...OP_STATEMENT_RECIPE.money, negative: "suffix" },
};

const noBalances: BankRecipe = {
  ...OP_STATEMENT_RECIPE,
  header: {
    ...OP_STATEMENT_RECIPE.header,
    openingBalance: String.raw`^EI-SALDOA (?<value>\d+,\d{2})$`,
    closingBalance: String.raw`^EI-SALDOA (?<value>\d+,\d{2})$`,
  },
};

describe("verifyToolDefinition", () => {
  test("is a function the model can call, named for what it does", () => {
    expect(verifyToolDefinition.name).toBe(VERIFY_TOOL_NAME);
    expect(verifyToolDefinition.input_schema.properties).toHaveProperty("recipe");
  });
});

describe("the verify_recipe handler", () => {
  test("passes a correct recipe and reports the balances with it", async () => {
    const session = createVerifySession(await fixture());

    const result = await session.tool.run({ recipe: OP_STATEMENT_RECIPE });

    expect(result.ok).toBe(true);
    expect(result.balance).toMatchObject({ delta: "0.00" });
    expect(result.rowCount).toBeGreaterThan(0);
    expect(session.verified()?.recipe).toEqual(OP_STATEMENT_RECIPE);
  });

  test("hands back at most three sample rows, as the recipe produced them", async () => {
    const session = createVerifySession(await fixture());

    const result = await session.tool.run({ recipe: OP_STATEMENT_RECIPE });
    const rows = session.verified()?.run.statement.rows ?? [];

    expect(result.sampleRows).toHaveLength(3);
    expect(result.sampleRows[0]).toMatchObject({
      date: rows[0]?.date ?? "",
      counterparty: rows[0]?.counterparty ?? "",
    });
  });

  test("reports a failing recipe as data, and records nothing as verified", async () => {
    const session = createVerifySession(await fixture());

    const result = await session.tool.run({ recipe: wrongSign });

    expect(result.ok).toBe(false);
    expect(session.verified()).toBeNull();
    expect(session.best()?.recipe).toEqual(wrongSign);
  });

  test("returns a schema-invalid candidate as a tool result, not a throw", async () => {
    const session = createVerifySession(await fixture());

    const result = await session.tool.run({ recipe: { kind: "bank" } });

    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("kelpaa");
    expect(session.best()).toBeNull();
  });

  test("returns a recipe that cannot find the balances as a tool result", async () => {
    const session = createVerifySession(await fixture());

    const result = await session.tool.run({ recipe: noBalances });

    expect(result.ok).toBe(false);
    expect(String(result.error)).toMatch(/saldo/i);
  });

  test("keeps the best attempt: the one that read the most rows", async () => {
    const session = createVerifySession(await fixture());

    await session.tool.run({ recipe: noBalances });
    await session.tool.run({ recipe: wrongSign });

    expect(session.best()?.recipe).toEqual(wrongSign);
    expect(session.best()?.run.statement.rows.length).toBeGreaterThan(0);
  });

  test("keeps the verified attempt even when a worse one follows", async () => {
    const session = createVerifySession(await fixture());

    await session.tool.run({ recipe: OP_STATEMENT_RECIPE });
    await session.tool.run({ recipe: wrongSign });

    expect(session.verified()?.recipe).toEqual(OP_STATEMENT_RECIPE);
  });
});

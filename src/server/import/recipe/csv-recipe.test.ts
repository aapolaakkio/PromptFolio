import { beforeEach, describe, expect, test } from "vitest";

import type { ChatClient, TurnParams } from "../../chat/runner.ts";
import { db } from "../../db/index.ts";
import { importRecipes, user } from "../../db/schema.ts";
import { type BankCsvRecipe, encodingOf, readBankCsvByRecipe, runCsvRecipe } from "./csv-recipe.ts";

const USER = "csv-recipe-user";

const bytesOf = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer;

const STATEMENT = bytesOf(
  [
    "Päivä,Summa,Tapahtuma,Saaja/Maksaja,Viesti,Tunnus",
    '03.06.2026,"-42,15",KORTTIOSTO,K-Market,,A1',
    '05.06.2026,"2 750,00",PALKKA,Työnantaja Oy,Kesäkuu,A2',
    '30.06.2026,"1,20",TALLETUSKORKO,Pankki,,A3',
  ].join("\n"),
);

const RECIPE: BankCsvRecipe = {
  kind: "bank-csv",
  delimiter: ",",
  columns: {
    date: "Päivä",
    amount: "Summa",
    debit: null,
    credit: null,
    label: "Tapahtuma",
    counterparty: "Saaja/Maksaja",
    message: "Viesti",
    externalId: "Tunnus",
  },
  dateFormat: "dd.mm.yyyy",
  money: { decimal: ",", thousands: " ", negative: "leading", twoColumn: false },
  interestLabels: ["KORKO"],
};

type Stub = ChatClient & { readonly asked: TurnParams[] };

const stub = (...replies: unknown[]): Stub => {
  const asked: TurnParams[] = [];
  return {
    asked,
    run: (params) => {
      asked.push(params);
      const reply = replies[asked.length - 1] ?? replies.at(-1);
      return Promise.resolve({ text: JSON.stringify(reply), toolCalls: [] });
    },
  };
};

beforeEach(async () => {
  await db.delete(importRecipes);
  await db
    .insert(user)
    .values({
      id: USER,
      name: "Test",
      email: `${USER}@example.test`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoNothing();
});

describe("runCsvRecipe", () => {
  test("reads every row by header name, signed, with interest told apart", () => {
    const run = runCsvRecipe(STATEMENT, RECIPE);

    expect(run.problems).toEqual([]);
    expect(run.rows.map((row) => [row.date, row.amount, row.type, row.externalId])).toEqual([
      ["2026-06-03", -4215n, "WITHDRAWAL", "A1"],
      ["2026-06-05", 275000n, "DEPOSIT", "A2"],
      ["2026-06-30", 120n, "INTEREST", "A3"],
    ]);
    expect(run.rows[1]?.note).toBe("PALKKA — Työnantaja Oy — Kesäkuu");
  });

  test("names the headers a recipe invented, and reads nothing", () => {
    const run = runCsvRecipe(STATEMENT, {
      ...RECIPE,
      columns: { ...RECIPE.columns, date: "Kirjauspäivä" },
    });
    expect(run.missingHeaders).toEqual(["Kirjauspäivä"]);
    expect(run.rows).toEqual([]);
  });

  test("a row it cannot read is a problem, not a guess", () => {
    const run = runCsvRecipe(STATEMENT, { ...RECIPE, dateFormat: "yyyy-mm-dd" });
    expect(run.rows).toEqual([]);
    expect(run.problems).toHaveLength(3);
  });
});

describe("encodingOf", () => {
  test("tells UTF-8, a UTF-16 byte-order mark and a legacy Windows export apart", () => {
    expect(encodingOf(bytesOf("Päivä;Summa"))).toBe("utf-8");
    expect(encodingOf(new Uint8Array([0xff, 0xfe, 0x50, 0x00]).buffer)).toBe("utf-16le");
    expect(encodingOf(new Uint8Array([0x50, 0xe4, 0x69, 0x76, 0xe4]).buffer)).toBe("latin1");
  });
});

describe("readBankCsvByRecipe", () => {
  test("asks once, stores the recipe that read every row, and asks nothing next time", async () => {
    const first = stub(RECIPE);
    const statement = await readBankCsvByRecipe(STATEMENT, USER, first);

    expect(statement.rows).toHaveLength(3);
    expect(first.asked).toHaveLength(1);
    expect(first.asked[0]?.response_format?.type).toBe("json_schema");
    expect(await db.select().from(importRecipes).all()).toHaveLength(1);

    const second = stub(RECIPE);
    await readBankCsvByRecipe(STATEMENT, USER, second);
    expect(second.asked).toHaveLength(0);
  });

  test("shows the model what failed and keeps the corrected answer", async () => {
    const client = stub({ ...RECIPE, columns: { ...RECIPE.columns, date: "Pvm" } }, RECIPE);

    const statement = await readBankCsvByRecipe(STATEMENT, USER, client);

    expect(statement.rows).toHaveLength(3);
    expect(client.asked).toHaveLength(2);
    expect(client.asked[1]?.messages.at(-1)?.content).toContain("Pvm");
  });

  test("a recipe that never reads every row fills the preview but is not stored", async () => {
    const client = stub({ ...RECIPE, dateFormat: "m.d.yyyy" });

    const statement = await readBankCsvByRecipe(STATEMENT, USER, client);

    expect(statement.rows.length).toBeGreaterThan(0);
    expect(statement.problems.length).toBeGreaterThan(0);
    expect(client.asked).toHaveLength(3);
    expect(await db.select().from(importRecipes).all()).toHaveLength(0);
  });

  test("a file the model cannot describe at all is refused", async () => {
    await expect(readBankCsvByRecipe(STATEMENT, USER, stub("no recipe"))).rejects.toThrow(
      "bank statement",
    );
  });
});

import { beforeEach, describe, expect, test } from "vitest";

import type { ChatClient } from "../../chat/runner.ts";
import { db } from "../../db/index.ts";
import { importRecipes, user } from "../../db/schema.ts";
import { readBytes } from "../../files.ts";
import { extractPages } from "../pdf-read.ts";
import { OP_STATEMENT_RECIPE } from "./op-reference.ts";
import { readBankPdfByRecipe, recipeKey } from "./read.ts";

const USER = "recipe-read-user";

const pdf = (): Promise<ArrayBuffer> =>
  readBytes(`${import.meta.dirname}/../fixtures/op-statement-sample.pdf`);

/** The key `readBankPdfByRecipe` will look under for this document. */
const keyFor = async (bytes: ArrayBuffer): Promise<string> =>
  recipeKey(bytes, (await extractPages(bytes))[0]?.text ?? "");

/** A model that answers with each scripted reply in turn, counting the asks. */
type Stub = ChatClient & { readonly calls: number };

const stub = (...replies: string[]): Stub => {
  let at = 0;
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    run: () => {
      calls += 1;
      const reply = replies[at] ?? replies.at(-1) ?? "";
      at += 1;
      return Promise.resolve({ text: reply, toolCalls: [] });
    },
  };
};

/**
 * A description that no longer fits its statement: its record-start matches no
 * line, so it reads the file as having no transactions at all and the printed
 * balances cannot be reached.
 */
const BROKEN_RECIPE = {
  ...OP_STATEMENT_RECIPE,
  recordStart: String.raw`^EI-OSU (?<date>\d{1,2}\.\d{1,2}\.\d{4}) (?<amount>\d+,\d{2})$`,
};

beforeEach(async () => {
  await db.delete(importRecipes);
  await db
    .insert(user)
    .values({
      id: USER,
      name: "Testi",
      email: `${USER}@example.test`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoNothing();
});

describe("readBankPdfByRecipe", () => {
  test("asks the model once and stores the recipe it verified", async () => {
    const client = stub(JSON.stringify(OP_STATEMENT_RECIPE));

    const run = await readBankPdfByRecipe(await pdf(), USER, client);

    expect(run.statement.rows.length).toBeGreaterThan(0);
    expect(client.calls).toBe(1);
    expect(await db.select().from(importRecipes).all()).toHaveLength(1);
  });

  test("the second import of the same format asks the model nothing", async () => {
    const first = stub(JSON.stringify(OP_STATEMENT_RECIPE));
    await readBankPdfByRecipe(await pdf(), USER, first);

    const second = stub("tätä ei pitäisi kysyä");
    const run = await readBankPdfByRecipe(await pdf(), USER, second);

    expect(second.calls).toBe(0);
    expect(run.statement.rows.length).toBeGreaterThan(0);
  });

  test("a stored recipe that stops working is forgotten and asked again", async () => {
    const bytes = await pdf();
    await db.insert(importRecipes).values({
      userId: USER,
      fingerprint: await keyFor(bytes),
      kind: "bank",
      recipe: JSON.stringify(BROKEN_RECIPE),
    });

    const client = stub(JSON.stringify(OP_STATEMENT_RECIPE));
    const run = await readBankPdfByRecipe(bytes, USER, client);

    // The stored description was found, failed, and was replaced by one that works.
    expect(client.calls).toBe(1);
    expect(run.statement.rows.length).toBeGreaterThan(0);
    const stored = await db.select().from(importRecipes).all();
    expect(stored).toHaveLength(1);
    expect(JSON.parse(stored[0]?.recipe ?? "{}")).toEqual(OP_STATEMENT_RECIPE);
  });

  test("an answer that does not verify is never stored", async () => {
    const client = stub(JSON.stringify(BROKEN_RECIPE), JSON.stringify(BROKEN_RECIPE));
    await readBankPdfByRecipe(await pdf(), USER, client);
    expect(await db.select().from(importRecipes).all()).toHaveLength(0);

    const better = stub(JSON.stringify(OP_STATEMENT_RECIPE));
    await readBankPdfByRecipe(await pdf(), USER, better);
    expect(await db.select().from(importRecipes).all()).toHaveLength(1);
  });

  test("refuses a PDF with no text layer", async () => {
    const scanned = await readBytes(`${import.meta.dirname}/../fixtures/scanned-no-text.pdf`);
    await expect(
      readBankPdfByRecipe(scanned, USER, stub(JSON.stringify(OP_STATEMENT_RECIPE))),
    ).rejects.toThrow(/tekstiä/);
  });
});

import { beforeEach, describe, expect, test } from "vitest";

import type { ChatClient, ModelReply } from "../../chat/runner.ts";
import { db } from "../../db/index.ts";
import { importRecipes, user } from "../../db/schema.ts";
import { readBytes } from "../../files.ts";
import { extractPages } from "../pdf-read.ts";
import { OP_STATEMENT_RECIPE } from "./op-reference.ts";
import { readBankPdfByRecipe, recipeKey } from "./read.ts";
import { VERIFY_TOOL_NAME } from "./verify-tool.ts";

const USER = "recipe-read-user";

const pdf = (): Promise<ArrayBuffer> =>
  readBytes(`${import.meta.dirname}/../fixtures/op-statement-sample.pdf`);

const keyFor = async (bytes: ArrayBuffer): Promise<string> =>
  recipeKey(bytes, (await extractPages(bytes))[0]?.text ?? "");

type Stub = ChatClient & { readonly calls: number };

const asCall = (reply: string): ModelReply => {
  try {
    return {
      text: "",
      toolCalls: [
        {
          id: "call_0",
          name: VERIFY_TOOL_NAME,
          arguments: JSON.stringify({ recipe: JSON.parse(reply) }),
        },
      ],
    };
  } catch {
    return { text: reply, toolCalls: [] };
  }
};

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
      return Promise.resolve(asCall(reply));
    },
  };
};

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
      name: "Test",
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

    const second = stub("this should not be asked");
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

  test("a stored recipe that burns the time budget surfaces instead of being swallowed", async () => {
    const bytes = await pdf();
    const key = await keyFor(bytes);
    await db.insert(importRecipes).values({
      userId: USER,
      fingerprint: key,
      kind: "bank",
      recipe: JSON.stringify(OP_STATEMENT_RECIPE),
    });

    const client = stub(JSON.stringify(OP_STATEMENT_RECIPE));
    await expect(readBankPdfByRecipe(bytes, USER, client, -1)).rejects.toThrow(/took too long/);
    expect(client.calls).toBe(0);
    expect(await db.select().from(importRecipes).all()).toHaveLength(0);
  });

  test("refuses a PDF with no text layer", async () => {
    const scanned = await readBytes(`${import.meta.dirname}/../fixtures/scanned-no-text.pdf`);
    await expect(
      readBankPdfByRecipe(scanned, USER, stub(JSON.stringify(OP_STATEMENT_RECIPE))),
    ).rejects.toThrow(/text/);
  });
});

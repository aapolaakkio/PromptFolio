import { describe, expect, test } from "vitest";
import { z } from "zod";

import { readText } from "../../files.ts";
import { BrokerRecordSchema, runBrokerRecord } from "./broker-record.ts";
import { OP_PASTE_RECIPE } from "./broker-reference.ts";

const fixture = (): Promise<string> =>
  readText(`${import.meta.dirname}/../fixtures/op-web-paste-sample.txt`);

const known = { knownIsins: new Map<string, number>(), knownNames: new Map<string, number>() };

describe("the OP paste reference recipe", () => {
  test("is a recipe the schema accepts", () => {
    expect(BrokerRecordSchema.safeParse(OP_PASTE_RECIPE).success).toBe(true);
  });

  test("reads the paste into exactly the transactions the hand-written parser did", async () => {
    // What OP's own parser produced from this fixture, frozen when the parser
    // was replaced by this recipe.
    const expected = z
      .object({ txns: z.array(z.unknown()), unknownIsins: z.array(z.unknown()) })
      .parse(
        JSON.parse(await readText(`${import.meta.dirname}/../fixtures/op-web-paste-expected.json`)),
      );

    const run = runBrokerRecord(await fixture(), OP_PASTE_RECIPE, known, 3);

    expect(run.failures).toEqual([]);
    expect(run.draft.txns.map(({ line: _line, ...rest }) => rest)).toEqual(expected.txns);
    expect(run.draft.unknownIsins).toEqual(expected.unknownIsins);
  });
});

describe("runBrokerRecord", () => {
  test("a record the pattern cannot read fails the check, naming its text", async () => {
    const text = (await fixture()).replace("10.08.2025", "elokuu");
    const run = runBrokerRecord(text, OP_PASTE_RECIPE, known, 3);

    expect(run.failures).toHaveLength(1);
    expect(run.failures[0]?.message).toContain("elokuu");
  });

  test("a skip pattern that ate a figure fails the check", async () => {
    const run = runBrokerRecord(
      await fixture(),
      { ...OP_PASTE_RECIPE, skip: [...OP_PASTE_RECIPE.skip, String.raw`^\d{2}\.\d{2}\.\d{4}$`] },
      known,
      3,
    );
    expect(run.failures.some((failure) => failure.message.includes("numeron"))).toBe(true);
  });
});

import { describe, expect, test } from "vitest";
import { z } from "zod";

import { readText } from "../../files.ts";
import { BrokerRecordSchema, runBrokerRecord, sampleOf } from "./broker-record.ts";
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

  test("a skip pattern that ate a whole transaction line fails the check", () => {
    const text = [
      "Päivä Laji Arvopaperi Summa",
      "10.08.2025 OSTO ESIMERKKI 300,02",
      "11.08.2025 MYYNTI ESIMERKKI 44,55",
      "12.08.2025 OSTO ESIMERKKI 10,00",
    ].join("\n");
    const recipe = {
      ...OP_PASTE_RECIPE,
      skip: [String.raw`^Päivä`, String.raw`MYYNTI`],
      recordStart: String.raw`^\d{2}\.`,
      record: String.raw`(?<tradeDate>\S+) (?<type>\S+) (?<instrumentName>\S+) (?<amount>\S+)`,
    };
    const run = runBrokerRecord(text, recipe, known, 3);
    expect(run.failures.some((failure) => failure.message.includes("tapahtumalta"))).toBe(true);
  });
});

describe("sampleOf", () => {
  test("shows a record of every length, even one first printed past the opening lines", () => {
    const buy = ["RAHASTO A", "OSTO", "10.01.2024", "1,0000   kpl", "100,00   EUR", "100,00   EUR"];
    const swap = ["FINNAIR OYJ", "VAIHTO - JÄTTÖ", "21.03.2024", "18,00   kpl"];
    // A ten-line heading, then buys: the 120-line opening ends four lines into
    // the sixteenth buy -- a cut-off record exactly as long as the swap.
    const heading = Array.from({ length: 10 }, (_, i) => `Otsikko ${i}`);
    const text = [
      ...heading,
      " ",
      ...Array.from({ length: 30 }, () => [...buy, " "]).flat(),
      ...swap,
    ].join("\n");

    expect(sampleOf(text)).toContain("VAIHTO - JÄTTÖ");
  });
});

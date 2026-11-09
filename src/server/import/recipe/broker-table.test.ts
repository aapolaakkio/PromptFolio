import { describe, expect, test } from "vitest";

import { readBytes } from "../../files.ts";
import { NORDNET } from "../fixtures/broker-mappings.ts";
import { parseCsv } from "../csv.ts";
import { mapRows } from "../map.ts";
import { BrokerTableSchema, runBrokerTable } from "./broker-table.ts";
import { NORDNET_TABLE_RECIPE } from "./broker-reference.ts";

const fixture = (): Promise<ArrayBuffer> =>
  readBytes(`${import.meta.dirname}/../fixtures/nordnet-sample.csv`);

const known = { knownIsins: new Map<string, number>(), knownNames: new Map<string, number>() };

// SAFETY: the body has the shape the route returns.
const bytesOf = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer;

describe("the Nordnet reference recipe", () => {
  test("is a recipe the schema accepts", () => {
    expect(BrokerTableSchema.safeParse(NORDNET_TABLE_RECIPE).success).toBe(true);
  });

  test("reads the export into exactly the draft the hand-written mapping did", async () => {
    const bytes = await fixture();
    const parsed = parseCsv(bytes, NORDNET);
    const expected = mapRows(parsed.rows, NORDNET, known.knownIsins, {
      accountId: 7,
      csvProblems: parsed.problems,
    });

    const run = runBrokerTable(bytes, NORDNET_TABLE_RECIPE, known, 7);

    expect(run.missingHeaders).toEqual([]);
    expect(run.draft.txns).toEqual(expected.txns);
    expect(run.draft.unknownIsins).toEqual(expected.unknownIsins);
    expect(run.draft.problems.map((p) => [p.line, p.message])).toEqual(
      expected.problems.map((p) => [p.line, p.message]),
    );
  });
});

describe("runBrokerTable", () => {
  const PASTED = [
    "Date\tAction\tSecurity\tISIN\tShares\tPrice\tTotal",
    "08/03/2026\tBuy\tExample ETF\tIE00B4L5Y983\t2\t100.50\t201.00",
    "08/20/2026\tSell\tExample ETF\tIE00B4L5Y983\t1\t110.00\t110.00",
    "08/21/2026\tReinvest\tExample ETF\tIE00B4L5Y983\t1\t110.00\t110.00",
  ].join("\n");

  const recipe = {
    kind: "broker-table" as const,
    delimiter: "\t" as const,
    columns: [
      { field: "tradeDate" as const, header: "Date", position: null },
      { field: "type" as const, header: "Action", position: null },
      { field: "instrumentName" as const, header: "Security", position: null },
      { field: "isin" as const, header: "ISIN", position: null },
      { field: "quantity" as const, header: "Shares", position: null },
      { field: "unitPrice" as const, header: "Price", position: null },
      { field: "amount" as const, header: "Total", position: null },
    ],
    dateFormat: "m.d.yyyy" as const,
    money: {
      decimal: "." as const,
      thousands: "," as const,
      negative: "leading" as const,
      twoColumn: false,
    },
    unsignedAmount: true,
    types: [
      { label: "Buy", type: "BUY" as const, reason: null, sign: -1 as const },
      { label: "Sell", type: "SELL" as const, reason: null, sign: 1 as const },
    ],
  };

  test("reads a pasted table: month-first dates, decimal points, signs from the label", () => {
    const run = runBrokerTable(bytesOf(PASTED), recipe, known, 1);
    const [buy, sell] = run.draft.txns;

    expect(buy?.tradeDate).toBe("2026-08-03");
    expect(buy?.amount).toBe(-20100);
    expect(sell?.amount).toBe(11000);
  });

  test("a label the recipe did not map fails the check instead of being guessed", () => {
    const run = runBrokerTable(bytesOf(PASTED), recipe, known, 1);

    expect(run.failures).toHaveLength(1);
    expect(run.failures[0]?.message).toContain("Reinvest");
  });

  test("a label deliberately ignored is reported but does not fail the check", () => {
    const withIgnore = {
      ...recipe,
      types: [
        ...recipe.types,
        { label: "Reinvest", type: "IGNORE" as const, reason: "On another row", sign: null },
      ],
    };
    const run = runBrokerTable(bytesOf(PASTED), withIgnore, known, 1);

    expect(run.failures).toEqual([]);
    expect(run.draft.problems).toHaveLength(1);
  });

  test("a header the file does not have is named and nothing is read", () => {
    const run = runBrokerTable(
      bytesOf(PASTED),
      {
        ...recipe,
        columns: [
          ...recipe.columns.slice(1),
          { field: "tradeDate", header: "Pvm", position: null },
        ],
      },
      known,
      1,
    );
    expect(run.missingHeaders).toEqual(["Pvm"]);
    expect(run.draft.txns).toEqual([]);
  });
});

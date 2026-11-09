import { describe, expect, test } from "vitest";
import { z } from "zod";

import type { ChatClient, ModelReply, TurnParams } from "../chat/runner.ts";
import {
  type ActionProblem,
  isCorporateAction,
  MAX_ACTIONS,
  proposeActions,
} from "./corporate-actions.ts";

const scripted = (text: string): ChatClient & { asked: TurnParams[] } => {
  const asked: TurnParams[] = [];
  return {
    asked,
    run: async (params): Promise<ModelReply> => {
      asked.push(params);
      return { text, toolCalls: [] };
    },
  };
};

const row = (line: number, raw: Record<string, string>, ignored = false): ActionProblem => ({
  line,
  message: `${raw.type ?? ""}: Unknown transaction type`,
  raw,
  ignored,
});

const OUT = row(4, {
  tradeDate: "2024-06-10",
  type: "SPLIT OTTO",
  instrumentName: "NOKIA",
  isin: "FI0009000681",
  quantity: "-100",
  amount: "-412.50",
});
const IN = row(5, {
  tradeDate: "2024-06-10",
  type: "SPLIT JÄTTÖ",
  instrumentName: "NOKIA",
  isin: "FI0009000681",
  quantity: "1000",
  amount: "0",
});

const BASE = {
  group: 0,
  kind: "split",
  terms: "1:10",
  effectiveDate: "2024-06-10",
  sourceUrl: "https://www.nokia.com/investors/split",
  taxNote: "A split is not a disposal; the cost basis spreads over the new units.",
  rows: [{ line: 5, type: "SPLIT", tradeDate: "2024-06-10", quantityText: "1000" }],
};
const action = (overrides: Partial<typeof BASE> = {}) => ({ ...BASE, ...overrides });

const reply = (actions: readonly unknown[]) =>
  `I searched the web.\n${JSON.stringify({ actions })}`;

describe("isCorporateAction", () => {
  test.each(["SPLIT OTTO", "VAIHTO AP-JÄTTÖ", "YHDISTELY - OTTO", "DESIM KIRJAUS OTTO"])(
    "%s is a corporate action",
    (type) => expect(isCorporateAction(row(1, { type }))).toBe(true),
  );

  test("an ignored row whose reason names a consolidation is one", () => {
    expect(
      isCorporateAction({
        line: 1,
        message: "VAIHTO X: Old share count of a share consolidation",
        raw: { type: "VAIHTO X" },
        ignored: true,
      }),
    ).toBe(true);
  });

  test.each(["TUNTEMATON", "OSTO"])("%s is not one", (type) =>
    expect(isCorporateAction(row(1, { type }))).toBe(false),
  );

  test("an unparsed line without a recipe type is not one", () => {
    expect(isCorporateAction({ line: 1, message: "Bad line", raw: {} })).toBe(false);
  });
});

describe("proposeActions", () => {
  test("a split pair gets a proposal whose quantities equal the broker rows", async () => {
    const client = scripted(reply([action()]));
    const [proposal, ...rest] = await proposeActions(client, [OUT, IN]);
    expect(rest).toEqual([]);
    expect(proposal).toMatchObject({
      lines: [4, 5],
      kind: "split",
      terms: "1:10",
      effectiveDate: "2024-06-10",
      sourceUrl: "https://www.nokia.com/investors/split",
      costBasisNeeded: [],
    });
    expect(proposal?.rows).toEqual([
      {
        line: 5,
        type: "SPLIT",
        tradeDate: "2024-06-10",
        isin: "FI0009000681",
        quantityText: "1000",
        amountEur: "0",
        feeEur: "0",
        currency: "EUR",
      },
    ]);
    expect(client.asked[0]?.tools.map((tool) => tool.name)).toEqual(["web_search"]);
  });

  test("the model sees no cash amounts", async () => {
    const client = scripted(reply([]));
    await proposeActions(client, [OUT, IN]);
    const sent = client.asked[0]?.messages.map((m) => m.content).join("\n") ?? "";
    expect(sent).not.toContain("412");
    expect(sent).toContain("FI0009000681");
    expect(sent).toContain("1000");
  });

  test("a proposal with a quantity not in the rows is dropped", async () => {
    const bad = action({
      rows: [{ line: 5, type: "SPLIT", tradeDate: "2024-06-10", quantityText: "999" }],
    });
    expect(await proposeActions(scripted(reply([bad])), [OUT, IN])).toEqual([]);
  });

  test("a quantity copied from the amount is not the row's quantity", async () => {
    const bad = action({
      rows: [{ line: 4, type: "TRANSFER_OUT", tradeDate: "2024-06-10", quantityText: "412.50" }],
    });
    expect(await proposeActions(scripted(reply([bad])), [OUT, IN])).toEqual([]);
  });

  test("a split that also moves units out of the same instrument is dropped", async () => {
    const both = action({
      rows: [
        { line: 4, type: "TRANSFER_OUT", tradeDate: "2024-06-10", quantityText: "100" },
        { line: 5, type: "SPLIT", tradeDate: "2024-06-10", quantityText: "1000" },
      ],
    });
    expect(await proposeActions(scripted(reply([both])), [OUT, IN])).toEqual([]);
  });

  test("units in on the row that removes units is dropped", async () => {
    const bad = action({
      rows: [{ line: 4, type: "TRANSFER_IN", tradeDate: "2024-06-10", quantityText: "100" }],
    });
    expect(await proposeActions(scripted(reply([bad])), [OUT, IN])).toEqual([]);
  });

  test("a date that is not the row's date drops the proposal", async () => {
    const bad = action({
      rows: [{ line: 5, type: "SPLIT", tradeDate: "2024-06-11", quantityText: "1000" }],
    });
    expect(await proposeActions(scripted(reply([bad])), [OUT, IN])).toEqual([]);
  });

  test("a row outside the action, or a type the app does not have, drops the proposal", async () => {
    const outside = action({
      rows: [{ line: 9, type: "SPLIT", tradeDate: "2024-06-10", quantityText: "1000" }],
    });
    const unknownType = action({
      rows: [{ line: 5, type: "BONUS", tradeDate: "2024-06-10", quantityText: "1000" }],
    });
    expect(await proposeActions(scripted(reply([outside])), [OUT, IN])).toEqual([]);
    expect(await proposeActions(scripted(reply([unknownType])), [OUT, IN])).toEqual([]);
  });

  test.each([
    "http://www.nokia.com/split",
    "https://127.0.0.1/split",
    "https://intranet/split",
    "javascript:alert(1)",
  ])("source %s drops the proposal", async (sourceUrl) => {
    expect(await proposeActions(scripted(reply([action({ sourceUrl })])), [OUT, IN])).toEqual([]);
  });

  test("a transfer in without a cost basis on its row asks the owner for it", async () => {
    const swapOut = row(7, {
      tradeDate: "2024-03-01",
      type: "VAIHTO AP-OTTO",
      isin: "FI0008000001",
      quantity: "-50",
    });
    const swapIn = row(8, {
      tradeDate: "2024-03-01",
      type: "VAIHTO AP-JÄTTÖ",
      isin: "FI0008000002",
      quantity: "50",
    });
    const swap = action({
      kind: "share swap",
      rows: [
        { line: 7, type: "TRANSFER_OUT", tradeDate: "2024-03-01", quantityText: "50" },
        { line: 8, type: "TRANSFER_IN", tradeDate: "2024-03-01", quantityText: "50" },
      ],
    });
    const [proposal] = await proposeActions(scripted(reply([swap])), [swapOut, swapIn]);
    expect(proposal?.costBasisNeeded).toEqual([8]);
    expect(proposal?.rows[1]).toMatchObject({ isin: "FI0008000002", amountEur: null });
  });

  test("a transfer in whose row carries the cost basis takes it from the row", async () => {
    const swapIn = row(8, {
      tradeDate: "2024-03-01",
      type: "VAIHTO AP-JÄTTÖ",
      isin: "FI0008000002",
      quantity: "50",
      costBasis: "1234.56",
    });
    const swap = action({
      kind: "share swap",
      rows: [{ line: 8, type: "TRANSFER_IN", tradeDate: "2024-03-01", quantityText: "50" }],
    });
    const [proposal] = await proposeActions(scripted(reply([swap])), [swapIn]);
    expect(proposal?.costBasisNeeded).toEqual([]);
    expect(proposal?.rows[0]?.amountEur).toBe("-1234.56");
  });

  test("model throws: no proposals", async () => {
    const failing: ChatClient = { run: () => Promise.reject(new Error("down")) };
    expect(await proposeActions(failing, [OUT, IN])).toEqual([]);
  });

  test("a refusal or an answer without JSON: no proposals", async () => {
    expect(await proposeActions(scripted("I cannot help with that."), [OUT, IN])).toEqual([]);
  });

  test("no corporate-action rows: no call", async () => {
    const client = scripted(reply([]));
    expect(await proposeActions(client, [row(1, { type: "TUNTEMATON" })])).toEqual([]);
    expect(client.asked).toHaveLength(0);
  });

  test(`more than ${MAX_ACTIONS} actions: one call with the first ${MAX_ACTIONS}`, async () => {
    const many = Array.from({ length: MAX_ACTIONS + 2 }, (_, k) =>
      row(k + 1, {
        tradeDate: `2024-01-${String(k + 1).padStart(2, "0")}`,
        type: "SPLIT JÄTTÖ",
        quantity: "10",
      }),
    );
    const client = scripted(reply([]));
    await proposeActions(client, many);
    expect(client.asked).toHaveLength(1);
    const sent = z
      .object({ actions: z.array(z.object({ id: z.number() })) })
      .parse(JSON.parse(client.asked[0]?.messages[1]?.content ?? ""));
    expect(sent.actions.map((a) => a.id)).toEqual([...Array(MAX_ACTIONS).keys()]);
  });
});

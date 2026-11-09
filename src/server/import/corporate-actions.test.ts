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
      skipped: [4],
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

const leg = (line: number, type: string, isin: string, quantity: string, date = "2024-03-01") =>
  row(line, { tradeDate: date, type, isin, quantity });
const booking = (line: number, type: string, quantityText: string, tradeDate = "2024-03-01") => ({
  line,
  type,
  tradeDate,
  quantityText,
});
const sentActions = (client: { asked: TurnParams[] }) =>
  z
    .object({
      actions: z.array(z.object({ id: z.number(), rows: z.array(z.object({ line: z.number() })) })),
    })
    .parse(JSON.parse(client.asked[0]?.messages[1]?.content ?? ""))
    .actions.map((a) => a.rows.map((r) => r.line));

describe("proposeActions books only whole, unit-moving actions", () => {
  const swapOut = leg(7, "VAIHTO AP-OTTO", "IE00BG5J1M21", "30");
  const swapIn = leg(8, "VAIHTO AP-JÄTTÖ", "IE00BJQTJ848", "12.5952");
  const swap = (rows: readonly ReturnType<typeof booking>[]) =>
    action({ kind: "share swap", effectiveDate: "2024-03-01", rows: [...rows] });

  test.each(["SELL", "BUY"])("a %s booking is dropped", async (type) => {
    const bad = swap([booking(7, type, "30"), booking(8, "TRANSFER_IN", "12.5952")]);
    expect(await proposeActions(scripted(reply([bad])), [swapOut, swapIn])).toEqual([]);
  });

  test("a swap whose OTTO prints a positive quantity books both legs with the rows' quantities", async () => {
    const good = swap([booking(7, "TRANSFER_OUT", "30"), booking(8, "TRANSFER_IN", "12.59520")]);
    const [proposal] = await proposeActions(scripted(reply([good])), [swapOut, swapIn]);
    expect(proposal?.rows.map((r) => [r.line, r.type, r.quantityText])).toEqual([
      [7, "TRANSFER_OUT", "30"],
      [8, "TRANSFER_IN", "12.5952"],
    ]);
    expect(proposal?.skipped).toEqual([]);
  });

  test("a quantity that only matches under another reading of the marks is dropped", async () => {
    const big = leg(5, "SPLIT JÄTTÖ", "FI0009000681", "1000", "2024-06-10");
    const bad = action({ rows: [booking(5, "SPLIT", "1.000", "2024-06-10")] });
    expect(await proposeActions(scripted(reply([bad])), [OUT, big])).toEqual([]);
  });

  test("a positive-quantity row cannot be TRANSFER_OUT", async () => {
    const merged = leg(9, "FUUSIO", "FI4000567029", "40");
    const bad = action({
      kind: "merger",
      effectiveDate: "2024-03-01",
      rows: [booking(9, "TRANSFER_OUT", "40")],
    });
    expect(await proposeActions(scripted(reply([bad])), [merged])).toEqual([]);
  });

  test("a negative-quantity row cannot be TRANSFER_IN", async () => {
    const merged = leg(9, "FUUSIO", "FI4000567029", "-40");
    const bad = action({
      kind: "merger",
      effectiveDate: "2024-03-01",
      rows: [booking(9, "TRANSFER_IN", "40")],
    });
    expect(await proposeActions(scripted(reply([bad])), [merged])).toEqual([]);
  });

  test("a swap booking only its in-leg is dropped", async () => {
    const bad = swap([booking(8, "TRANSFER_IN", "12.5952")]);
    expect(await proposeActions(scripted(reply([bad])), [swapOut, swapIn])).toEqual([]);
  });

  test("a SPLIT without an out-leg of the same ISIN is dropped", async () => {
    const bad = action({ rows: [booking(5, "SPLIT", "1000", "2024-06-10")] });
    expect(await proposeActions(scripted(reply([bad])), [IN])).toEqual([]);
  });

  test("two same-day splits of different instruments are separate actions", async () => {
    const otherOut = leg(10, "SPLIT OTTO", "US0378331005", "-5", "2024-06-10");
    const otherIn = leg(11, "SPLIT JÄTTÖ", "US0378331005", "20", "2024-06-10");
    const second = action({ group: 1, rows: [booking(11, "SPLIT", "20", "2024-06-10")] });
    const client = scripted(reply([second]));
    const proposals = await proposeActions(client, [OUT, IN, otherOut, otherIn]);
    expect(sentActions(client)).toEqual([
      [4, 5],
      [10, 11],
    ]);
    expect(proposals.map((p) => [p.lines, p.skipped])).toEqual([[[10, 11], [10]]]);
  });

  test("a row of another action on the same day drops the proposal", async () => {
    const otherIn = leg(11, "SPLIT JÄTTÖ", "US0378331005", "20", "2024-06-10");
    const otherOut = leg(10, "SPLIT OTTO", "US0378331005", "-5", "2024-06-10");
    const bad = action({
      rows: [booking(5, "SPLIT", "1000", "2024-06-10"), booking(11, "SPLIT", "20", "2024-06-10")],
    });
    expect(await proposeActions(scripted(reply([bad])), [OUT, IN, otherOut, otherIn])).toEqual([]);
  });

  test("two same-day swaps cannot be told apart and are not sent", async () => {
    const client = scripted(reply([]));
    const moreOut = leg(20, "VAIHTO AP-OTTO", "FI0009000681", "10");
    const moreIn = leg(21, "VAIHTO AP-JÄTTÖ", "FI4000567029", "4");
    expect(await proposeActions(client, [swapOut, swapIn, moreOut, moreIn])).toEqual([]);
    expect(client.asked).toHaveLength(0);
  });
});

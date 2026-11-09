import { describe, expect, test, vi } from "vitest";

import type { ChatClient, ModelReply, TurnParams } from "../chat/runner.ts";
import { MAX_SUGGESTED_ROWS, redacted, suggestRows, type SuggestProblem } from "./suggest-rows.ts";

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

const reply = (rows: readonly { id: number; fields: Record<string, string | null> }[]) =>
  JSON.stringify({ rows });

const BROKER_RAW = "12.03.2024 OSTO Nokia Oyj FI0009000681 100 kpl 3,85 EUR 1 234,50";
const broker: SuggestProblem = { line: 7, raw: BROKER_RAW, message: "Unknown type: OSTO" };

const blanks = {
  tradeDate: null,
  type: null,
  isin: null,
  quantityText: null,
  amountEur: null,
  feeEur: null,
  currency: null,
};

describe("suggestRows broker", () => {
  test("prefills date, type, isin, quantity, amount and currency read from the raw text", async () => {
    const client = scripted(
      reply([
        {
          id: 0,
          fields: {
            ...blanks,
            tradeDate: "2024-03-12",
            type: "BUY",
            isin: "FI0009000681",
            quantityText: "100",
            amountEur: "1234.50",
            currency: "EUR",
          },
        },
      ]),
    );
    const out = await suggestRows(client, "broker", [broker], []);
    expect(out.get(0)).toEqual({
      tradeDate: "2024-03-12",
      type: "BUY",
      isin: "FI0009000681",
      quantityText: "100",
      amountEur: "1234.50",
      currency: "EUR",
    });
  });

  test("drops an invented amount but keeps the other fields", async () => {
    const client = scripted(
      reply([
        {
          id: 0,
          fields: { ...blanks, tradeDate: "2024-03-12", quantityText: "100", amountEur: "999.99" },
        },
      ]),
    );
    const out = await suggestRows(client, "broker", [broker], []);
    expect(out.get(0)).toEqual({ tradeDate: "2024-03-12", quantityText: "100" });
  });

  test("drops a date that is not in the text, an unknown type and a foreign currency", async () => {
    const client = scripted(
      reply([
        {
          id: 0,
          fields: {
            ...blanks,
            tradeDate: "2024-03-13",
            type: "GIFT",
            currency: "USD",
            feeEur: "3.85",
          },
        },
      ]),
    );
    const out = await suggestRows(client, "broker", [broker], []);
    expect(out.get(0)).toEqual({ feeEur: "3.85" });
  });

  test("a suggestion for a line that was not asked about is ignored", async () => {
    const client = scripted(reply([{ id: 99, fields: { ...blanks, quantityText: "100" } }]));
    expect((await suggestRows(client, "broker", [broker], [])).size).toBe(0);
  });

  test("one call covers at most MAX_SUGGESTED_ROWS problems, the first ones", async () => {
    const many = Array.from({ length: MAX_SUGGESTED_ROWS + 5 }, (_, at) => ({
      line: at + 1,
      raw: `row ${at + 1}`,
      message: "bad",
    }));
    const client = scripted(reply([]));
    await suggestRows(client, "broker", many, []);
    expect(client.asked).toHaveLength(1);
    const prompt = client.asked[0]?.messages.map((m) => m.content).join("\n") ?? "";
    expect(prompt).toContain(`"id":${MAX_SUGGESTED_ROWS - 1},`);
    expect(prompt).not.toContain(`"id":${MAX_SUGGESTED_ROWS},`);
  });

  test("no problems means no model call", async () => {
    const client = scripted("{}");
    expect((await suggestRows(client, "broker", [], [])).size).toBe(0);
    expect(client.asked).toHaveLength(0);
  });

  test("a throwing model gives no suggestions and does not throw", async () => {
    const client: ChatClient = {
      run: async () => {
        throw new Error("down");
      },
    };
    expect((await suggestRows(client, "broker", [broker], [])).size).toBe(0);
  });

  test("a malformed reply gives no suggestions", async () => {
    expect((await suggestRows(scripted("not json"), "broker", [broker], [])).size).toBe(0);
  });

  test("the prompt carries the raw text, the recipe's message and the examples", async () => {
    const client = scripted(reply([]));
    await suggestRows(client, "broker", [broker], [{ tradeDate: "2024-01-02" }]);
    const prompt = client.asked[0]?.messages.map((m) => m.content).join("\n") ?? "";
    expect(prompt).toContain("Unknown type: OSTO");
    expect(prompt).toContain("FI0009000681");
    expect(prompt).toContain('"tradeDate":"2024-01-02"');
  });
});

describe("suggestRows bank", () => {
  const raw = "05.02.2024 Prisma Kamppi -45,60 viite 123";
  const problem: SuggestProblem = { line: 3, raw, message: "Unrecognised line" };

  test("prefills date, type, amount and counterparty; drops a counterparty not in the text", async () => {
    const ok = await suggestRows(
      scripted(
        reply([
          {
            id: 0,
            fields: {
              date: "2024-02-05",
              type: "WITHDRAWAL",
              amountEur: "-45.60",
              counterparty: "Prisma Kamppi",
            },
          },
        ]),
      ),
      "bank",
      [problem],
      [],
    );
    expect(ok.get(0)).toEqual({
      date: "2024-02-05",
      type: "WITHDRAWAL",
      amountEur: "-45.60",
      counterparty: "Prisma Kamppi",
    });
    const bad = await suggestRows(
      scripted(
        reply([
          {
            id: 0,
            fields: { date: null, type: null, amountEur: null, counterparty: "K-Market" },
          },
        ]),
      ),
      "bank",
      [problem],
      [],
    );
    expect(bad.size).toBe(0);
  });
});

const askOne = async (
  kind: "broker" | "bank",
  raw: string,
  fields: Record<string, string | null>,
) => {
  const out = await suggestRows(
    scripted(reply([{ id: 0, fields }])),
    kind,
    [{ line: 1, raw, message: "bad" }],
    [],
  );
  return out.get(0) ?? {};
};

const bankFields = (over: Record<string, string | null>) => ({
  date: null,
  type: null,
  amountEur: null,
  counterparty: null,
  ...over,
});
const brokerFields = (over: Record<string, string | null>) => ({ ...blanks, ...over });

describe("number checks", () => {
  test("a thousands reading of a decimal is refused", async () => {
    expect(await askOne("bank", "Prisma -45,60", bankFields({ amountEur: "4560" }))).toEqual({});
  });

  test("digits that only come from a date, an ISIN or an IBAN are refused", async () => {
    const raw = "12.03.2024 FI0009000681 FI21 1234 5600 0007 85 OSTO";
    for (const value of ["2024", "0009000681", "1234", "85"]) {
      expect(await askOne("broker", raw, brokerFields({ quantityText: value }))).toEqual({});
    }
  });

  test("a spaced thousands number is accepted whole, never as a piece", async () => {
    const raw = "OSTO 1 234,56";
    expect(await askOne("broker", raw, brokerFields({ amountEur: "1234.56" }))).toEqual({
      amountEur: "1234.56",
    });
    expect(await askOne("broker", raw, brokerFields({ amountEur: "234,56" }))).toEqual({});
    expect(await askOne("broker", raw, brokerFields({ quantityText: "1" }))).toEqual({});
  });

  test("a yearless date's digits are not numbers", async () => {
    expect(
      await askOne("broker", "OSTO 03.02. Nokia", brokerFields({ quantityText: "3" })),
    ).toEqual({});
  });
});

describe("sign and type checks", () => {
  test.each([
    ["-45,60", "-45.60"],
    ["−45,60", "-45.60"],
    ["45,60-", "-45.60"],
    ["(45,60)", "-45.60"],
    ["45,60 DB", "-45.60"],
  ])("printed negative %s is accepted only as a negative amount", async (printed, value) => {
    const raw = `Prisma ${printed}`;
    expect(await askOne("bank", raw, bankFields({ amountEur: value }))).toEqual({
      amountEur: value,
    });
    expect(await askOne("bank", raw, bankFields({ amountEur: "45.60" }))).toEqual({});
  });

  test("a printed positive amount cannot be made negative", async () => {
    expect(await askOne("bank", "Palkka 45,60", bankFields({ amountEur: "-45.60" }))).toEqual({});
  });

  test("a bank type must agree with the amount's sign, and needs a checked amount", async () => {
    const raw = "Prisma -45,60";
    expect(await askOne("bank", raw, bankFields({ amountEur: "-45.60", type: "DEPOSIT" }))).toEqual(
      { amountEur: "-45.60" },
    );
    expect(await askOne("bank", raw, bankFields({ type: "WITHDRAWAL" }))).toEqual({});
    expect(
      await askOne("bank", "Korko 1,20", bankFields({ amountEur: "1.20", type: "INTEREST" })),
    ).toEqual({ amountEur: "1.20", type: "INTEREST" });
  });

  test("a broker type needs one of the app's own type keywords for it in the text", async () => {
    expect(await askOne("broker", "OSTO Nokia", brokerFields({ type: "BUY" }))).toEqual({
      type: "BUY",
    });
    expect(await askOne("broker", "OSTO Nokia", brokerFields({ type: "SELL" }))).toEqual({});
    expect(await askOne("broker", "Nokia 100 kpl", brokerFields({ type: "BUY" }))).toEqual({});
  });

  test("labels match whole words: NOSTO is never a purchase", async () => {
    expect(await askOne("broker", "NOSTO 100,00", brokerFields({ type: "BUY" }))).toEqual({});
    expect(await askOne("broker", "NOSTO 100,00", brokerFields({ type: "WITHDRAWAL" }))).toEqual({
      type: "WITHDRAWAL",
    });
    expect(await askOne("broker", "Ostokeskus Oyj 5", brokerFields({ type: "BUY" }))).toEqual({});
  });

  test("a row with a buy and a sell label gets no type", async () => {
    const raw = "OSTO Nokia MYYNTI";
    expect(await askOne("broker", raw, brokerFields({ type: "BUY" }))).toEqual({});
    expect(await askOne("broker", raw, brokerFields({ type: "SELL" }))).toEqual({});
  });
});

describe("keys and privacy", () => {
  test("two problems on the same line are checked against their own text", async () => {
    const out = await suggestRows(
      scripted(
        reply([
          { id: 0, fields: bankFields({ amountEur: "-10.00" }) },
          { id: 1, fields: bankFields({ amountEur: "-10.00" }) },
        ]),
      ),
      "bank",
      [
        { line: 5, raw: "A -10,00", message: "bad" },
        { line: 5, raw: "B -20,00", message: "bad" },
      ],
      [],
    );
    expect(out.get(0)).toEqual({ amountEur: "-10.00" });
    expect(out.has(1)).toBe(false);
  });

  test("no IBAN, reference number or example detail reaches the model", async () => {
    const client = scripted(reply([]));
    await suggestRows(
      client,
      "bank",
      [
        {
          line: 1,
          raw: "Prisma -45,60 FI21 1234 5600 0007 85 viite 12345678901234",
          message: "Unrecognised line: FI2112345600000785",
        },
      ],
      [
        {
          date: "2024-01-02",
          type: "DEPOSIT",
          amountEur: "2750.00",
          counterparty: "ESIMERKKI OYJ",
        },
      ],
    );
    const prompt = client.asked[0]?.messages.map((m) => m.content).join("\n") ?? "";
    expect(prompt).not.toMatch(/FI21|1234 5600|12345678901234|FI2112345600000785/);
    expect(prompt).not.toContain("ESIMERKKI");
    expect(prompt).not.toContain("2750");
    expect(prompt).toContain("9999.99");
    expect(prompt).toContain("2024-01-02");
  });

  test("a failure is logged server side", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await suggestRows(
      {
        run: async () => {
          throw new Error("down");
        },
      },
      "bank",
      [{ line: 1, raw: "x", message: "m" }],
      [],
    );
    expect(warn).toHaveBeenCalledWith("Row suggestions failed:", "Error");
    warn.mockRestore();
  });
});

describe("redacted", () => {
  test.each([
    ["fi21 1234 5600 0007 85", "[IBAN]"],
    ["FI21-1234-5600-0007-85", "[IBAN]"],
    ["FI21.1234.5600.0007.85", "[IBAN]"],
    ["FI2112345600000785", "[IBAN]"],
    ["1234 5678 9012 3456", "[REF]"],
    ["1234\u00a05678\u00a09012\u00a03456", "[REF]"],
    ["123456-789", "[REF]"],
    ["tili123456789", "tili[REF]"],
    ["2026-03-12345678901", "[REF]"],
  ])("%s is masked", (value, mask) => {
    expect(redacted(`viite ${value} loppu`)).toBe(`viite ${mask} loppu`);
  });

  test.each([
    "1 234 567,89",
    "12.03.2026",
    "2026-03-12 100,00",
    "FI0009000681 100 kpl",
    "ISIN FI4000567029",
    "-45,60 EUR",
  ])("%s is left readable", (value) => {
    expect(redacted(value)).toBe(value);
  });
});

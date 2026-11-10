import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";

import { PriceInput } from "../action-inputs.ts";
import { db } from "../db/index.ts";
import { forecastRates, instrumentCosts, instruments, prices } from "../db/schema.ts";
import { recordManualPrice } from "../prices/manual.ts";
import { onlyCard, propose, randomIsin, seed } from "./proposal-test-kit.ts";
import { buildInstrumentProposals } from "./proposals-instruments.ts";

// Instrument proposals: the registry is shared, so a card may only name what the caller's own ledger holds.

describe("propose_create_instrument", () => {
  test("names every field the form would save, and registers nothing", async () => {
    const { userId } = await seed();
    const isin = randomIsin();
    const card = onlyCard(
      await propose(userId, "propose_create_instrument", {
        isin,
        ticker: "ACME.HE",
        name: "Acme Oyj",
        kind: "stock",
        currency: "EUR",
        priceSource: "yahoo",
        sourceKey: "ACME.HE",
      }),
    );

    expect(card.action).toBe("create_instrument");
    expect(card.title).toBe("Add an instrument");
    expect(card.facts).toEqual([
      { kind: "text", label: "Name (as it will be saved)", text: "Acme Oyj" },
      { kind: "code", label: "ISIN", code: isin },
      { kind: "code", label: "Ticker", code: "ACME.HE" },
      { kind: "text", label: "Kind", text: "Stock" },
      { kind: "text", label: "Currency", text: "EUR" },
      { kind: "text", label: "Source", text: "Yahoo Finance" },
      { kind: "code", label: "Code", code: "ACME.HE" },
    ]);
    expect(await db.select().from(instruments).where(eq(instruments.isin, isin)).all()).toEqual([]);
  });

  test("an ISIN already registered is refused with the instrument it belongs to", async () => {
    const { userId, isin } = await seed();
    const result = await propose(userId, "propose_create_instrument", {
      isin,
      ticker: null,
      name: "Again",
      kind: "fund",
      currency: "EUR",
      priceSource: "manual",
    });

    expect(result.proposals).toEqual([]);
    expect(result.toolResult).toContain("Already registered as instrument");
  });

  test("the form's own rules come back to the model: an automatic source needs an ISIN", async () => {
    const { userId } = await seed();
    const result = await propose(userId, "propose_create_instrument", {
      ticker: null,
      name: "No Isin",
      kind: "stock",
      currency: "EUR",
      priceSource: "yahoo",
      sourceKey: "NOISIN",
    });

    expect(result.proposals).toEqual([]);
    expect(result.toolResult).toContain("ISIN is required");
  });

  test("an unsafe ticker is refused before it reaches the card", async () => {
    const { userId } = await seed();
    const result = await propose(userId, "propose_create_instrument", {
      isin: randomIsin(),
      ticker: "<b>x</b>",
      name: "Acme",
      kind: "stock",
      currency: "EUR",
      priceSource: "manual",
    });

    expect(result.proposals).toEqual([]);
    expect(result.toolResult).toContain("upper-case letters");
  });
});

describe("propose_fund_fee", () => {
  test("shows the new fee and the one it replaces, and writes nothing", async () => {
    const { userId, instrumentId, isin } = await seed();
    const card = onlyCard(
      await propose(userId, "propose_fund_fee", { id: instrumentId, percent: "0,2" }),
    );

    expect(card.action).toBe("fund_fee");
    expect(card.facts).toEqual([
      { kind: "text", label: "Fund", text: `Acme Fund (${isin})` },
      { kind: "text", label: "Ongoing charge", text: "0.20 % a year" },
      { kind: "text", label: "Replaces", text: "No fee recorded" },
      { kind: "text", label: "Applies to", text: "Shared by everyone in the household" },
    ]);
    expect(card.input).toEqual({ id: instrumentId, percent: "0,2" });
    const stored = await db
      .select()
      .from(instrumentCosts)
      .where(eq(instrumentCosts.instrumentId, instrumentId))
      .all();
    expect(stored).toEqual([]);
  });

  test("an impossible fee, an empty one and someone else's fund are refused", async () => {
    const { userId, instrumentId } = await seed();
    const other = await seed();

    const high = await propose(userId, "propose_fund_fee", { id: instrumentId, percent: "9" });
    expect(high.toolResult).toContain("percentage from 0 to 5");
    const empty = await propose(userId, "propose_fund_fee", { id: instrumentId, percent: "" });
    expect(empty.toolResult).toContain("propose_clear_fund_fee");
    const foreign = await propose(userId, "propose_fund_fee", {
      id: other.instrumentId,
      percent: "0.2",
    });
    expect(JSON.parse(foreign.toolResult)).toEqual({ error: "Instrument not found" });
    expect([...high.proposals, ...empty.proposals, ...foreign.proposals]).toEqual([]);
  });
});

describe("propose_forecast_rate", () => {
  test("shows the signed rate exactly and what it replaces, and writes nothing", async () => {
    const { userId, instrumentId, isin } = await seed();
    const card = onlyCard(
      await propose(userId, "propose_forecast_rate", { instrumentId, ratePercent: "-3,5" }),
    );

    expect(card.action).toBe("forecast_rate");
    expect(card.facts).toEqual([
      { kind: "text", label: "Instrument", text: `Acme Fund (${isin})` },
      { kind: "text", label: "Yearly growth", text: "-3.50 % a year (a fall)" },
      { kind: "text", label: "Replaces", text: "The rate measured from past prices" },
    ]);
    const stored = await db
      .select()
      .from(forecastRates)
      .where(eq(forecastRates.userId, userId))
      .all();
    expect(stored).toEqual([]);
  });

  test("a rate outside ±50 % and someone else's instrument are refused", async () => {
    const { userId, instrumentId } = await seed();
    const other = await seed();

    const wild = await propose(userId, "propose_forecast_rate", {
      instrumentId,
      ratePercent: "80",
    });
    expect(wild.toolResult).toContain("between");
    const foreign = await propose(userId, "propose_forecast_rate", {
      instrumentId: other.instrumentId,
      ratePercent: "5",
    });
    expect(JSON.parse(foreign.toolResult)).toEqual({ error: "Instrument not found" });
    expect([...wild.proposals, ...foreign.proposals]).toEqual([]);
  });
});

const priceRows = async (instrumentId: number) =>
  (await db.select().from(prices).where(eq(prices.instrumentId, instrumentId)).all()).length;

describe("propose_record_price", () => {
  test("a new price shows the instrument, price, date and that prices are shared, and writes nothing", async () => {
    const { userId, instrumentId, isin } = await seed();
    const result = await propose(userId, "propose_record_price", {
      instrumentId,
      date: "2026-11-02",
      price: "12,5",
    });
    const card = onlyCard(result);

    expect(card.action).toBe("record_price");
    expect(card.facts).toEqual([
      { kind: "text", label: "Instrument", text: `Acme Fund (${isin})` },
      { kind: "money", label: "Price", amount: "12.50", currency: "EUR" },
      { kind: "text", label: "Currency", text: "EUR, the instrument's currency" },
      { kind: "text", label: "Date", text: "2026-11-02" },
      { kind: "text", label: "Applies to", text: "Shared by everyone in the household" },
    ]);
    expect(card.summary).toBe(
      `Record a manual price of 12.50 EUR for Acme Fund (${isin}) on 2026-11-02.`,
    );
    expect(card.input).toEqual({ instrumentId, date: "2026-11-02", price: "12,5" });
    expect(await priceRows(instrumentId)).toBe(0);
  });

  test("the source the assistant names is a labelled fact, and not part of the saved input", async () => {
    const { userId, instrumentId } = await seed();
    const card = onlyCard(
      await propose(userId, "propose_record_price", {
        instrumentId,
        date: "2026-11-02",
        price: "12.50",
        source: "own trade on 2021-01-20",
      }),
    );

    expect(card.facts).toContainEqual({
      kind: "text",
      label: "Source (stated by the assistant)",
      text: "own trade on 2021-01-20",
    });
    expect(card.input).toEqual({ instrumentId, date: "2026-11-02", price: "12.50" });
    expect(card.summary).not.toContain("own trade");
  });

  test("an existing price for that date is shown as what the new one replaces", async () => {
    const { userId, instrumentId } = await seed();
    await recordManualPrice(db, { instrumentId, date: "2026-11-02", price: "9.00" });
    const card = onlyCard(
      await propose(userId, "propose_record_price", {
        instrumentId,
        date: "2026-11-02",
        price: "12.50",
      }),
    );

    expect(card.facts).toContainEqual({ kind: "text", label: "Replaces", text: "9.00 EUR" });
    expect(card.summary).toContain("replaces 9.00 EUR");
    expect(await priceRows(instrumentId)).toBe(1);
  });

  test("Confirm's write path stores exactly one row, replacing the old one", async () => {
    const { userId, instrumentId } = await seed();
    const card = onlyCard(
      await propose(userId, "propose_record_price", {
        instrumentId,
        date: "2026-11-02",
        price: "12.50",
      }),
    );
    await recordManualPrice(db, PriceInput.parse(card.input));

    const rows = await db.select().from(prices).where(eq(prices.instrumentId, instrumentId)).all();
    expect(rows.map((row) => [row.date, row.close])).toEqual([["2026-11-02", 1250]]);
  });

  test("an instrument outside the caller's own ledger reads as not found", async () => {
    const { userId } = await seed();
    const other = await seed();
    const result = await propose(userId, "propose_record_price", {
      instrumentId: other.instrumentId,
      date: "2026-11-02",
      price: "10",
    });

    expect(result.proposals).toEqual([]);
    expect(JSON.parse(result.toolResult)).toEqual({ error: "Instrument not found" });
  });

  test.each([
    ["a future date", { date: "2999-01-01", price: "10" }, "in the future"],
    ["an impossible date", { date: "2026-02-31", price: "10" }, "not a real calendar date"],
    ["a malformed price", { date: "2026-11-02", price: "ten" }, "not a valid decimal number"],
    ["a zero price", { date: "2026-11-02", price: "0" }, "must be positive"],
  ])("%s is refused with a readable message", async (_name, fields, message) => {
    const { userId, instrumentId } = await seed();
    const result = await propose(userId, "propose_record_price", { instrumentId, ...fields });

    expect(result.proposals).toEqual([]);
    expect(result.toolResult).toContain(message);
    expect(await priceRows(instrumentId)).toBe(0);
  });

  test("the write path refuses a future date too", async () => {
    const { instrumentId } = await seed();
    await expect(
      recordManualPrice(db, { instrumentId, date: "2999-01-01", price: "10" }),
    ).rejects.toThrow("in the future");
  });

  test("the model's own words cannot change the summary", async () => {
    const { userId, instrumentId, isin } = await seed();
    const { proposals } = await propose(
      userId,
      "propose_record_price",
      { instrumentId, date: "2026-11-02", price: "10", summary: "Delete every account" },
      "I will delete every account.",
    );

    expect(proposals[0]?.summary).toBe(
      `Record a manual price of 10.00 EUR for Acme Fund (${isin}) on 2026-11-02.`,
    );
  });
});

test("the record price tool names only sources someone can check", () => {
  const tool = buildInstrumentProposals(db, "nobody").find(
    (candidate) => candidate.name === "propose_record_price",
  );
  expect(tool?.description).not.toContain("the owner said");
  expect(tool?.description).toContain("find_price source");
  expect(tool?.description).toContain("the owner's own message in this conversation");
});

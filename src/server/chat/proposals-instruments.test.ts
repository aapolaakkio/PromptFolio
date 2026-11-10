import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";

import { db } from "../db/index.ts";
import { forecastRates, instrumentCosts, instruments } from "../db/schema.ts";
import { onlyCard, propose, randomIsin, seed } from "./proposal-test-kit.ts";

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

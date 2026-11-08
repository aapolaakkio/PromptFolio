import { describe, expect, test } from "vitest";

import { parseCurrency } from "../../core/money.ts";
import { db } from "../db/index.ts";
import { eq } from "drizzle-orm";

import { prices } from "../db/schema.ts";
import { addInstrument, listInstruments, updateInstrument } from "./store.ts";

// What api/instruments.test.ts checked through HTTP, checked here against the
// function itself. Gone with the route: three "rejects a request with no
// session" cases, now the authed middleware's job, and two asserting a 400's
// field detail, now zod's before a handler runs.

const EUR = parseCurrency("EUR");
const SEK = parseCurrency("SEK");

const randomIsin = (): string =>
  `XX${crypto.randomUUID().replace(/-/g, "").toUpperCase().slice(0, 9)}0`;

describe("addInstrument", () => {
  test("registers one and hands back the stored row", async () => {
    const isin = randomIsin();

    const created = await addInstrument(db, {
      isin,
      ticker: "KNEBV.HE",
      name: "Kone",
      kind: "stock",
      currency: EUR,
      priceSource: "manual",
      sourceKey: "KNEBV.HE",
    });

    expect(created.isin).toBe(isin);
    expect(created.name).toBe("Kone");
  });

  test("refuses a duplicate ISIN, naming it", async () => {
    const isin = randomIsin();
    const row = {
      isin,
      ticker: null,
      name: `Kesko ${isin}`,
      kind: "stock" as const,
      currency: EUR,
      priceSource: "manual" as const,
      sourceKey: isin,
    };
    await addInstrument(db, row);

    // The ISIN is in the message because it is what the person is looking at
    // when they hit this: a broker row they were trying to resolve.
    await expect(addInstrument(db, row)).rejects.toThrow(isin);
  });

  test("refuses a duplicate name when there is no ISIN to match on", async () => {
    // A delisted share or a corporate-action line has no ISIN any registry
    // will give up, so the name is the only thing left to match.
    const name = `Manuaalinen ${crypto.randomUUID()}`;
    const row = {
      ticker: null,
      name,
      kind: "stock" as const,
      currency: EUR,
      priceSource: "manual" as const,
    };
    await addInstrument(db, row);

    await expect(addInstrument(db, row)).rejects.toThrow(name);
  });

  test("keeps a non-EUR currency as its own", async () => {
    const isin = randomIsin();

    const created = await addInstrument(db, {
      isin,
      ticker: null,
      name: `Ruotsalainen ${isin}`,
      kind: "stock",
      currency: SEK,
      priceSource: "manual",
      sourceKey: isin,
    });

    expect(created.currency).toBe(SEK);
  });

  test("falls back to the ISIN, then the name, for a missing source key", async () => {
    const isin = randomIsin();
    const byIsin = await addInstrument(db, {
      isin,
      ticker: null,
      name: `Ilman avainta ${isin}`,
      kind: "fund",
      currency: EUR,
      priceSource: "manual",
    });
    const name = `Nimellä ${crypto.randomUUID()}`;
    const byName = await addInstrument(db, {
      ticker: null,
      name,
      kind: "fund",
      currency: EUR,
      priceSource: "manual",
    });

    expect(byIsin.sourceKey).toBe(isin);
    expect(byName.sourceKey).toBe(name);
  });
});

describe("listInstruments", () => {
  test("returns what any signed-in member can see, which is all of them", async () => {
    // Instruments are shared reference data: two household members'
    // transactions reference the same Nokia share, so there is nothing to
    // scope per user and nothing to leak between them.
    const isin = randomIsin();
    await addInstrument(db, {
      isin,
      ticker: null,
      name: `Jaettu ${isin}`,
      kind: "stock",
      currency: EUR,
      priceSource: "manual",
      sourceKey: isin,
    });

    expect((await listInstruments(db)).some((row) => row.isin === isin)).toBe(true);
  });
});

describe("updateInstrument", () => {
  const add = () =>
    addInstrument(db, {
      isin: randomIsin(),
      ticker: null,
      name: "Nordnet Norge Indeks",
      kind: "fund",
      currency: EUR,
      priceSource: "manual",
      sourceKey: "",
    });

  test("corrects the currency, and drops prices stored in the old one", async () => {
    const fund = await add();
    await db
      .insert(prices)
      .values({
        instrumentId: fund.id,
        date: "2026-11-05",
        close: 1000,
        currency: EUR,
        source: "manual",
        fetchedAt: new Date(),
      })
      .run();

    const updated = await updateInstrument(db, fund.id, {
      currency: parseCurrency("NOK"),
      priceSource: "nordnet_fund",
      sourceKey: "nordnet-norge-indeks-nok-52540035",
    });

    expect(updated.currency).toBe("NOK");
    expect(updated.priceSource).toBe("nordnet_fund");
    expect(updated.sourceKey).toBe("nordnet-norge-indeks-nok-52540035");
    expect(await db.select().from(prices).where(eq(prices.instrumentId, fund.id)).all()).toEqual(
      [],
    );
  });

  test("keeps stored prices when the currency stays the same", async () => {
    const fund = await add();
    await db
      .insert(prices)
      .values({
        instrumentId: fund.id,
        date: "2026-11-05",
        close: 1000,
        currency: EUR,
        source: "manual",
        fetchedAt: new Date(),
      })
      .run();

    await updateInstrument(db, fund.id, { currency: EUR, priceSource: "manual", sourceKey: "" });

    expect(
      await db.select().from(prices).where(eq(prices.instrumentId, fund.id)).all(),
    ).toHaveLength(1);
  });

  test("refuses an automatic source with no source code, and an unknown instrument", async () => {
    const fund = await add();
    await expect(
      updateInstrument(db, fund.id, { currency: EUR, priceSource: "nordnet_fund", sourceKey: " " }),
    ).rejects.toThrow("Lähdetunnus");
    await expect(
      updateInstrument(db, 999_999, { currency: EUR, priceSource: "manual", sourceKey: "" }),
    ).rejects.toThrow("ei löytynyt");
  });
});

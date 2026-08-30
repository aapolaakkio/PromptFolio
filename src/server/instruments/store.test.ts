import { beforeAll, describe, expect, test } from "vitest";

import { parseCurrency } from "../../core/money.ts";
import { getDb } from "../db/index.ts";
import { addInstrument, listInstruments } from "./store.ts";

// What api/instruments.test.ts checked through HTTP, checked here against the
// function itself. Gone with the route: three "rejects a request with no
// session" cases, now the authed middleware's job, and two asserting a 400's
// field detail, now zod's before a handler runs.

const EUR = parseCurrency("EUR");
const SEK = parseCurrency("SEK");

let db: ReturnType<typeof getDb>["db"];

beforeAll(() => {
  db = getDb().db;
});

const randomIsin = (): string =>
  `XX${crypto.randomUUID().replace(/-/g, "").toUpperCase().slice(0, 9)}0`;

describe("addInstrument", () => {
  test("registers one and hands back the stored row", () => {
    const isin = randomIsin();

    const created = addInstrument(db, {
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

  test("refuses a duplicate ISIN, naming it", () => {
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
    addInstrument(db, row);

    // The ISIN is in the message because it is what the person is looking at
    // when they hit this: a broker row they were trying to resolve.
    expect(() => addInstrument(db, row)).toThrow(isin);
  });

  test("refuses a duplicate name when there is no ISIN to match on", () => {
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
    addInstrument(db, row);

    expect(() => addInstrument(db, row)).toThrow(name);
  });

  test("keeps a non-EUR currency as its own", () => {
    const isin = randomIsin();

    const created = addInstrument(db, {
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

  test("falls back to the ISIN, then the name, for a missing source key", () => {
    const isin = randomIsin();
    const byIsin = addInstrument(db, {
      isin,
      ticker: null,
      name: `Ilman avainta ${isin}`,
      kind: "fund",
      currency: EUR,
      priceSource: "manual",
    });
    const name = `Nimellä ${crypto.randomUUID()}`;
    const byName = addInstrument(db, {
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
  test("returns what any signed-in member can see, which is all of them", () => {
    // Instruments are shared reference data: two household members'
    // transactions reference the same Nokia share, so there is nothing to
    // scope per user and nothing to leak between them.
    const isin = randomIsin();
    addInstrument(db, {
      isin,
      ticker: null,
      name: `Jaettu ${isin}`,
      kind: "stock",
      currency: EUR,
      priceSource: "manual",
      sourceKey: isin,
    });

    expect(listInstruments(db).some((row) => row.isin === isin)).toBe(true);
  });
});

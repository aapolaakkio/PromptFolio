import { eq, inArray } from "drizzle-orm";
import { afterEach, describe, expect, test } from "vitest";

import { parseCurrency } from "../../core/money.ts";
import { db } from "../db/index.ts";
import { instrumentLookups, instruments, yahooGate } from "../db/schema.ts";
import type { FetchImpl } from "../prices/types.ts";
import type { InstrumentLookup } from "./lookup.ts";
import { resolvePending } from "./resolve-pending.ts";
import { addInstrument, updateInstrument } from "./store.ts";

const EUR = parseCurrency("EUR");
const USD = parseCurrency("USD");

const freshIsin = (): string =>
  `XS${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}${Math.floor(Math.random() * 10)}`;

const usedIsins: string[] = [];

const noNetwork: FetchImpl = () => Promise.reject(new Error("no request expected"));

const remember = async (isin: string, result: InstrumentLookup): Promise<void> => {
  await db
    .insert(instrumentLookups)
    .values({
      key: isin,
      outcome: result.outcome,
      result: JSON.stringify(result),
      checkedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: instrumentLookups.key,
      set: { outcome: result.outcome, result: JSON.stringify(result), checkedAt: new Date() },
    });
};

const lookup = (isin: string, over: Partial<InstrumentLookup>): InstrumentLookup => ({
  kind: "etf",
  name: "Registry Name",
  priceSource: "yahoo",
  sourceKey: "ABC.HE",
  isin,
  listingCurrency: USD,
  outcome: "found",
  formReason: null,
  ...over,
});

const addPending = async (isin: string) => {
  usedIsins.push(isin);
  return await addInstrument(db, {
    isin,
    ticker: null,
    name: "Broker Name",
    kind: "stock",
    currency: EUR,
    priceSource: "manual",
    sourceKey: isin,
    lookupStatus: "pending",
  });
};

const row = async (id: number) =>
  await db.select().from(instruments).where(eq(instruments.id, id)).get();

afterEach(async () => {
  if (usedIsins.length > 0) {
    await db.delete(instrumentLookups).where(inArray(instrumentLookups.key, usedIsins));
    await db.delete(instruments).where(inArray(instruments.isin, usedIsins));
  }
  usedIsins.length = 0;
  await db.delete(yahooGate).run();
});

describe("resolvePending", () => {
  test("a pending instrument gets its source once Yahoo answers", async () => {
    const isin = freshIsin();
    const created = await addPending(isin);
    await remember(isin, lookup(isin, {}));

    const result = await resolvePending(db, noNetwork);

    expect(result.resolved).toBeGreaterThanOrEqual(1);
    expect(await row(created.id)).toMatchObject({
      priceSource: "yahoo",
      sourceKey: "ABC.HE",
      currency: USD,
      kind: "etf",
      name: "Broker Name",
      lookupStatus: "ok",
    });
  });

  test("a pending one that lands in a form case is marked for attention", async () => {
    const isin = freshIsin();
    const created = await addPending(isin);
    await remember(
      isin,
      lookup(isin, {
        outcome: "form",
        formReason: "nothing",
        priceSource: null,
        sourceKey: null,
        kind: null,
        listingCurrency: null,
      }),
    );

    const result = await resolvePending(db, noNetwork);

    expect(result.attention).toBeGreaterThanOrEqual(1);
    expect(await row(created.id)).toMatchObject({
      lookupStatus: "attention",
      priceSource: "manual",
    });
  });

  test("an instrument edited in Muokkaa while pending is left alone", async () => {
    const isin = freshIsin();
    const created = await addPending(isin);
    await updateInstrument(db, created.id, {
      currency: EUR,
      priceSource: "yahoo",
      sourceKey: "MINE.HE",
    });
    await remember(isin, lookup(isin, {}));

    await resolvePending(db, noNetwork);

    expect(await row(created.id)).toMatchObject({
      priceSource: "yahoo",
      sourceKey: "MINE.HE",
      currency: EUR,
      lookupStatus: "ok",
    });
  });
});

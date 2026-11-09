import { eq, inArray } from "drizzle-orm";
import { afterEach, describe, expect, test } from "vitest";

import { parseCurrency } from "../../core/money.ts";
import { db } from "../db/index.ts";
import { instrumentLookups, instruments, yahooGate } from "../db/schema.ts";
import type { Draft, DraftTxn } from "../import/map.ts";
import type { FetchImpl } from "../prices/types.ts";
import { createAdded, resolveUnknown } from "./auto-add.ts";
import type { InstrumentLookup } from "./lookup.ts";
import { lookupKey } from "./lookup-cache.ts";

const EUR = parseCurrency("EUR");

/** A fresh, ISIN-shaped code per call: the suite shares one database. */
const freshIsin = (): string =>
  `XS${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}${Math.floor(Math.random() * 10)}`;

const usedKeys: string[] = [];
const usedIsins: string[] = [];

const noNetwork: FetchImpl = () => Promise.reject(new Error("no request expected"));

const found = (isin: string | null, over: Partial<InstrumentLookup> = {}): InstrumentLookup => ({
  kind: "stock",
  name: "Registry Name",
  priceSource: "yahoo",
  sourceKey: "NOKIA.HE",
  isin,
  listingCurrency: EUR,
  outcome: "found",
  formReason: null,
  ...over,
});

const remember = async (key: string, result: InstrumentLookup): Promise<void> => {
  usedKeys.push(key);
  await db
    .insert(instrumentLookups)
    .values({ key, outcome: result.outcome, result: JSON.stringify(result), checkedAt: new Date() })
    .onConflictDoUpdate({
      target: instrumentLookups.key,
      set: { outcome: result.outcome, result: JSON.stringify(result), checkedAt: new Date() },
    });
};

const txn = (over: Partial<DraftTxn>): DraftTxn => ({
  line: 2,
  accountId: 1,
  instrumentId: null,
  isin: null,
  type: "BUY",
  tradeDate: "2025-01-01",
  quantity: 1_000_000,
  unitPrice: 1000,
  amount: -1000,
  fee: 0,
  tax: 0,
  currency: EUR,
  fxRateEur: 100_000_000,
  externalId: null,
  note: null,
  ...over,
});

const draftOf = (txns: DraftTxn[], unknownIsins: Draft["unknownIsins"]): Draft => ({
  txns,
  problems: [],
  unknownIsins,
  added: [],
});

const track = (isin: string): string => {
  usedIsins.push(isin);
  usedKeys.push(isin);
  return isin;
};

afterEach(async () => {
  if (usedKeys.length > 0) {
    await db.delete(instrumentLookups).where(inArray(instrumentLookups.key, usedKeys));
  }
  if (usedIsins.length > 0) {
    await db.delete(instruments).where(inArray(instruments.isin, usedIsins));
  }
  usedKeys.length = 0;
  usedIsins.length = 0;
  await db.delete(yahooGate).run();
});

describe("resolveUnknown", () => {
  test("a found ISIN is listed as added and leaves unknownIsins", async () => {
    const isin = track(freshIsin());
    await remember(isin, found(isin));
    const draft = draftOf(
      [txn({ isin, instrumentName: "NOKIA" })],
      [{ isin, name: "NOKIA", currency: EUR }],
    );

    const resolved = await resolveUnknown(db, draft, noNetwork);

    expect(resolved.unknownIsins).toEqual([]);
    expect(resolved.added).toEqual([
      {
        isin,
        name: "NOKIA",
        kind: "stock",
        currency: "EUR",
        priceSource: "yahoo",
        sourceKey: "NOKIA.HE",
        pending: false,
      },
    ]);
  });

  test("a form-case ISIN stays unknown", async () => {
    const isin = track(freshIsin());
    await remember(
      isin,
      found(isin, { outcome: "form", formReason: "currency", priceSource: null, sourceKey: null }),
    );
    const unknown = [{ isin, name: "SOMETHING", currency: EUR }];

    const resolved = await resolveUnknown(db, draftOf([txn({ isin })], unknown), noNetwork);

    expect(resolved.unknownIsins).toEqual(unknown);
    expect(resolved.added).toEqual([]);
  });

  test("one ISIN on many rows is looked up once", async () => {
    const isin = track(freshIsin());
    await remember(isin, found(isin));
    // Two files merged into one review: the same ISIN listed twice.
    const draft = draftOf(
      [txn({ isin, line: 2 }), txn({ isin, line: 3 }), txn({ isin, line: 4 })],
      [
        { isin, name: "NOKIA", currency: EUR },
        { isin, name: "NOKIA", currency: EUR },
      ],
    );

    const resolved = await resolveUnknown(db, draft, noNetwork);

    expect(resolved.added.map((a) => a.isin)).toEqual([isin]);
    expect(resolved.unknownIsins).toEqual([]);
  });

  test("an OP fund row gets its discovered ISIN", async () => {
    const isin = track(freshIsin());
    const name = `OP-TESTI ${crypto.randomUUID()}`;
    await remember(
      lookupKey(null, name),
      found(isin, { kind: "fund", priceSource: "op_fund", sourceKey: "op-testi" }),
    );
    const draft = draftOf(
      [txn({ instrumentName: name }), txn({ instrumentName: "OTHER", line: 3 })],
      [{ isin: null, name, currency: EUR }],
    );

    const resolved = await resolveUnknown(db, draft, noNetwork);

    expect(resolved.txns.map((t) => t.isin)).toEqual([isin, null]);
    expect(resolved.added.map((a) => [a.isin, a.priceSource])).toEqual([[isin, "op_fund"]]);
    expect(resolved.unknownIsins).toEqual([]);
  });

  test("a lookup that fails outright leaves the instrument unknown", async () => {
    const isin = track(freshIsin());
    const unknown = [{ isin, name: "BROKEN", currency: EUR }];
    const throwing: FetchImpl = () => {
      throw new Error("boom");
    };

    const resolved = await resolveUnknown(db, draftOf([txn({ isin })], unknown), throwing);

    expect(resolved.unknownIsins).toEqual(unknown);
  });
});

const stored = (isin: string) =>
  db.select().from(instruments).where(eq(instruments.isin, isin)).all();

describe("createAdded", () => {
  test("creates each instrument once and links every row", async () => {
    const isin = track(freshIsin());
    await remember(isin, found(isin));
    const draft = draftOf(
      [txn({ isin, line: 2 }), txn({ isin, line: 3 }), txn({ line: 4, type: "DEPOSIT" })],
      [],
    );

    const created = await createAdded(db, draft);

    const rows = await stored(isin);
    expect(rows).toHaveLength(1);
    expect(created.txns.map((t) => t.instrumentId)).toEqual([rows[0]?.id, rows[0]?.id, null]);
    expect(rows[0]?.lookupStatus).toBe("ok");
    expect(created.unknownIsins).toEqual([]);
  });

  test("an ISIN that already exists is reused", async () => {
    const isin = track(freshIsin());
    await remember(isin, found(isin));
    const first = await createAdded(db, draftOf([txn({ isin })], []));
    const second = await createAdded(db, draftOf([txn({ isin })], []));

    expect(await stored(isin)).toHaveLength(1);
    expect(second.txns[0]?.instrumentId).toBe(first.txns[0]?.instrumentId);
  });

  test("a pending one is created as manual with lookupStatus pending", async () => {
    const isin = track(freshIsin());
    await remember(
      isin,
      found(isin, {
        outcome: "pending",
        kind: null,
        name: null,
        priceSource: null,
        sourceKey: null,
        listingCurrency: null,
      }),
    );

    await createAdded(db, draftOf([txn({ isin, instrumentName: "PENDING OYJ" })], []));

    const [row] = await stored(isin);
    expect(row).toMatchObject({
      priceSource: "manual",
      sourceKey: isin,
      lookupStatus: "pending",
      kind: "stock",
      name: "PENDING OYJ",
    });
  });

  test("values in the client draft are ignored in favour of the remembered lookup", async () => {
    const isin = track(freshIsin());
    await remember(isin, found(isin));
    const draft: Draft = {
      ...draftOf([txn({ isin })], []),
      added: [
        {
          isin,
          name: "NOKIA",
          kind: "etf",
          currency: "EUR",
          priceSource: "op_fund",
          sourceKey: "EVIL",
          pending: false,
        },
      ],
    };

    await createAdded(db, draft);

    const [row] = await stored(isin);
    expect(row).toMatchObject({ sourceKey: "NOKIA.HE", priceSource: "yahoo", kind: "stock" });
  });

  test("an ISIN with nothing remembered stays unresolved, and commit is refused", async () => {
    const isin = track(freshIsin());

    const created = await createAdded(db, draftOf([txn({ isin, instrumentName: "X" })], []));

    expect(await stored(isin)).toHaveLength(0);
    expect(created.txns[0]?.instrumentId).toBeNull();
    expect(created.unknownIsins).toEqual([{ isin, name: "X", currency: EUR }]);
  });

  test("an OP fund row is linked through the lookup remembered under its name", async () => {
    const isin = track(freshIsin());
    const name = `OP-TESTI ${crypto.randomUUID()}`;
    await remember(
      lookupKey(null, name),
      found(isin, { kind: "fund", priceSource: "op_fund", sourceKey: "op-testi" }),
    );

    const created = await createAdded(db, draftOf([txn({ isin, instrumentName: name })], []));

    const [row] = await stored(isin);
    expect(row).toMatchObject({ priceSource: "op_fund", sourceKey: "op-testi", name });
    expect(created.txns[0]?.instrumentId).toBe(row?.id);
  });
});

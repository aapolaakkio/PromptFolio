import { eq } from "drizzle-orm";
import { expect, test } from "vitest";

import { EUR } from "../../core/money.ts";
import type { ChatClient, TurnParams } from "../chat/runner.ts";
import { testDb } from "../db/test-db.ts";
import { accounts, instrumentCosts, instruments, transactions, user } from "../db/schema.ts";
import { IDENTITY_WINDOW_CHARS } from "../prices/page-recipe.ts";
import {
  MAX_COST_LOOKUPS_PER_RUN,
  chargeOnPage,
  parseChargePercent,
  refreshCosts,
  setOwnCharge,
} from "./costs.ts";

const ISIN = "FI0008800511";
const OTHER_ISIN = "FI0008812342";
const URL_OK = "https://funds.example.fi/suomi";
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 9);

test("exact basis points: 0,20 % does not confirm 0.02 %, 1,20 % does not confirm 0.20 %", () => {
  expect(chargeOnPage(`${ISIN} Juoksevat kulut 0,20 %`, ISIN, 20)).toBe(true);
  expect(chargeOnPage(`${ISIN} Juoksevat kulut 0,20 %`, ISIN, 2)).toBe(false);
  expect(chargeOnPage(`${ISIN} Juoksevat kulut 1,20 %`, ISIN, 20)).toBe(false);
  expect(chargeOnPage(`${ISIN} Juoksevat kulut 1,20 %`, ISIN, 120)).toBe(true);
  expect(chargeOnPage(`${ISIN} ongoing charge 0.2 %`, ISIN, 20)).toBe(true);
  expect(chargeOnPage(`${ISIN} TER 0.20%`, ISIN, 20)).toBe(true);
  expect(chargeOnPage(`${ISIN} OCF 10,20 %`, ISIN, 20)).toBe(false);
});

test("the ISIN must be whole and within the window of the percentage", () => {
  const far = "x".repeat(IDENTITY_WINDOW_CHARS + 10);
  expect(chargeOnPage(`${ISIN}${far}TER 0,20 %`, ISIN, 20)).toBe(false);
  expect(chargeOnPage(`TER 0,20 % ${far}${ISIN}`, ISIN, 20)).toBe(false);
  expect(chargeOnPage(`TER 0,20 % X${ISIN}9`, ISIN, 20)).toBe(false);
  expect(chargeOnPage(`TER 0,20 % only`, ISIN, 20)).toBe(false);
});

type Db = Awaited<ReturnType<typeof testDb>>["db"];

const seedFund = async (
  db: Db,
  userId: string,
  over: Partial<typeof instruments.$inferInsert> = {},
) => {
  const fund = await db
    .insert(instruments)
    .values({
      isin: crypto.randomUUID().slice(0, 12),
      name: "Fund",
      kind: "fund",
      currency: EUR,
      priceSource: "manual",
      sourceKey: "x",
      ...over,
    })
    .returning()
    .get();
  const account = await db.select().from(accounts).where(eq(accounts.userId, userId)).get();
  if (account === undefined) throw new Error("no account");
  await db
    .insert(transactions)
    .values({
      accountId: account.id,
      instrumentId: fund.id,
      type: "BUY",
      tradeDate: "2025-01-02",
      quantity: 1_000_000,
      amount: 100,
      currency: EUR,
      fxRateEur: 100_000_000,
      contentHash: crypto.randomUUID(),
    })
    .run();
  return fund;
};

const setup = async () => {
  const { db } = await testDb();
  const userId = crypto.randomUUID();
  await db
    .insert(user)
    .values({
      id: userId,
      name: "T",
      email: `${userId}@example.com`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();
  await db
    .insert(accounts)
    .values({ userId, name: "A", broker: "nordnet", baseCurrency: EUR })
    .run();
  return { db, userId };
};

const reply = (text: string | Error): ChatClient & { asked: TurnParams[] } => {
  const asked: TurnParams[] = [];
  return {
    asked,
    run: async (params) => {
      asked.push(params);
      if (text instanceof Error) throw text;
      return { text, toolCalls: [] };
    },
  };
};

const answer = (percent: number | null, url: string | null = URL_OK): string =>
  JSON.stringify({ ongoingChargePercent: percent, url });

const page = (body: string) => async () => new Response(body);
const stored = async (db: Db, id: number) =>
  await db.select().from(instrumentCosts).where(eq(instrumentCosts.instrumentId, id)).get();

test("a verified lookup stores basis points, url and source", async () => {
  const { db, userId } = await setup();
  const fund = await seedFund(db, userId, { isin: ISIN });
  const client = reply(answer(0.2));
  await refreshCosts(db, { client, fetchImpl: page(`${ISIN} juoksevat kulut 0,20 %`), now: NOW });
  expect(await stored(db, fund.id)).toEqual({
    instrumentId: fund.id,
    ongoingChargeBp: 20,
    sourceUrl: URL_OK,
    checkedAt: NOW,
    source: "ai",
  });
  expect(JSON.stringify(client.asked[0]?.messages)).toContain(ISIN);
});

test("a percentage not on the page stores null with checkedAt", async () => {
  const { db, userId } = await setup();
  const fund = await seedFund(db, userId, { isin: ISIN });
  await refreshCosts(db, {
    client: reply(answer(0.2)),
    fetchImpl: page(`${ISIN} juoksevat kulut 0,25 %`),
    now: NOW,
  });
  expect(await stored(db, fund.id)).toMatchObject({
    ongoingChargeBp: null,
    checkedAt: NOW,
    source: "ai",
  });
});

test("a percentage near another fund's ISIN only stores null", async () => {
  const { db, userId } = await setup();
  const fund = await seedFund(db, userId, { isin: ISIN });
  const far = "x".repeat(IDENTITY_WINDOW_CHARS + 10);
  const html = `${ISIN} ${far} ${OTHER_ISIN} juoksevat kulut 0,20 %`;
  await refreshCosts(db, { client: reply(answer(0.2)), fetchImpl: page(html), now: NOW });
  expect((await stored(db, fund.id))?.ongoingChargeBp).toBeNull();
});

test("a value over 5 % is refused without fetching", async () => {
  const { db, userId } = await setup();
  const fund = await seedFund(db, userId, { isin: ISIN });
  let fetched = 0;
  const fetchImpl = async () => {
    fetched += 1;
    return new Response(`${ISIN} 7,50 %`);
  };
  await refreshCosts(db, { client: reply(answer(7.5)), fetchImpl, now: NOW });
  expect(fetched).toBe(0);
  expect((await stored(db, fund.id))?.ongoingChargeBp).toBeNull();
});

test("a user-set fee is not overwritten or asked again", async () => {
  const { db, userId } = await setup();
  const fund = await seedFund(db, userId, { isin: ISIN });
  await db
    .insert(instrumentCosts)
    .values({
      instrumentId: fund.id,
      ongoingChargeBp: 55,
      sourceUrl: null,
      checkedAt: NOW - 800 * DAY,
      source: "user",
    })
    .run();
  const client = reply(answer(0.2));
  await refreshCosts(db, { client, fetchImpl: page(`${ISIN} TER 0,20 %`), now: NOW });
  expect(client.asked).toHaveLength(0);
  expect((await stored(db, fund.id))?.ongoingChargeBp).toBe(55);
});

test("caps at 3 lookups; skips stocks, recent rows and unheld funds", async () => {
  const { db, userId } = await setup();
  const funds = [];
  for (let n = 0; n < 5; n += 1)
    funds.push(await seedFund(db, userId, { isin: `FI00000000${n}0` }));
  await seedFund(db, userId, { isin: "FI0000000099", kind: "stock" });
  await db
    .insert(instruments)
    .values({
      isin: "FI0000000098",
      name: "Unheld",
      kind: "fund",
      currency: EUR,
      priceSource: "manual",
      sourceKey: "x",
    })
    .run();
  const recent = await seedFund(db, userId, { isin: "FI0000000097", kind: "etf" });
  await db
    .insert(instrumentCosts)
    .values({
      instrumentId: recent.id,
      ongoingChargeBp: 10,
      sourceUrl: null,
      checkedAt: NOW - 100 * DAY,
      source: "ai",
    })
    .run();
  const client = reply(answer(null, null));
  await refreshCosts(db, { client, fetchImpl: page(""), now: NOW });
  expect(MAX_COST_LOOKUPS_PER_RUN).toBe(3);
  expect(client.asked).toHaveLength(3);
  expect(await db.select().from(instrumentCosts).all()).toHaveLength(4);
  expect(funds).toHaveLength(5);
});

test("staleness: 365 days for a value, 30 days for a null", async () => {
  const { db, userId } = await setup();
  const withValue = await seedFund(db, userId, { isin: "FI0000000001" });
  const withNull = await seedFund(db, userId, { isin: "FI0000000002" });
  await db
    .insert(instrumentCosts)
    .values([
      {
        instrumentId: withValue.id,
        ongoingChargeBp: 10,
        sourceUrl: null,
        checkedAt: NOW - 364 * DAY,
        source: "ai",
      },
      {
        instrumentId: withNull.id,
        ongoingChargeBp: null,
        sourceUrl: null,
        checkedAt: NOW - 31 * DAY,
        source: "ai",
      },
    ])
    .run();
  const client = reply(answer(null, null));
  await refreshCosts(db, { client, fetchImpl: page(""), now: NOW });
  expect(client.asked).toHaveLength(1);
  expect((await stored(db, withNull.id))?.checkedAt).toBe(NOW);
  expect((await stored(db, withValue.id))?.checkedAt).toBe(NOW - 364 * DAY);
});

test("a transient or a permanent model failure stores null with checkedAt, so one fund cannot hold a slot nightly", async () => {
  const { db, userId } = await setup();
  const fund = await seedFund(db, userId, { isin: ISIN });
  const down = Object.assign(new Error("down"), { status: 529 });
  await refreshCosts(db, { client: reply(down), fetchImpl: page(""), now: NOW });
  expect(await stored(db, fund.id)).toMatchObject({ ongoingChargeBp: null, checkedAt: NOW });
  await refreshCosts(db, {
    client: reply(new Error("refused")),
    fetchImpl: page(""),
    now: NOW + 40 * DAY,
  });
  expect(await stored(db, fund.id)).toMatchObject({
    ongoingChargeBp: null,
    checkedAt: NOW + 40 * DAY,
  });
});

test("no client: nothing happens", async () => {
  const { db, userId } = await setup();
  const fund = await seedFund(db, userId, { isin: ISIN });
  await refreshCosts(db, { client: null, fetchImpl: page(""), now: NOW });
  expect(await stored(db, fund.id)).toBeUndefined();
});

test("the owner's percentage text is read to basis points, 0 to 5 % only", () => {
  expect(parseChargePercent("0,20")).toBe(20);
  expect(parseChargePercent(" 0.2 % ")).toBe(20);
  expect(parseChargePercent("5")).toBe(500);
  expect(parseChargePercent("5,01")).toBeNull();
  expect(parseChargePercent("0,205")).toBeNull();
  expect(parseChargePercent("abc")).toBeNull();
  expect(parseChargePercent("-1")).toBeNull();
});

test("setting your own fee stores source user; clearing it hands back to lookups", async () => {
  const { db, userId } = await setup();
  const fund = await seedFund(db, userId, { isin: ISIN });
  await setOwnCharge(db, fund.id, 35, NOW);
  expect(await stored(db, fund.id)).toMatchObject({
    ongoingChargeBp: 35,
    source: "user",
    checkedAt: NOW,
  });
  await setOwnCharge(db, fund.id, null, NOW);
  expect(await stored(db, fund.id)).toBeUndefined();
});

test("a percentage without an ongoing-charge keyword is refused (entry or performance fee)", () => {
  expect(chargeOnPage(`${ISIN} entry fee 0 %`, ISIN, 0)).toBe(false);
  expect(chargeOnPage(`${ISIN} performance fee 20 %`, ISIN, 2000)).toBe(false);
  expect(chargeOnPage(`${ISIN} Performance fee 1,50 %`, ISIN, 150)).toBe(false);
  expect(chargeOnPage(`${ISIN} Årlig avgift 0,45 %`, ISIN, 45)).toBe(true);
  expect(chargeOnPage(`${ISIN} Jatkuvat kulut 0,45 %`, ISIN, 45)).toBe(true);
});

test("with several ISINs on the page the nearest one to the percentage must be ours", () => {
  const html = `${ISIN} A-class ${OTHER_ISIN} B-class Ongoing charge 0,20 %`;
  expect(chargeOnPage(html, ISIN, 20)).toBe(false);
  expect(chargeOnPage(html, OTHER_ISIN, 20)).toBe(true);
  expect(
    chargeOnPage(`${OTHER_ISIN} Ongoing charge 0,90 % ${ISIN} Ongoing charge 0,20 %`, ISIN, 20),
  ).toBe(true);
});

test("a looked-up 0 is refused", async () => {
  const { db, userId } = await setup();
  const fund = await seedFund(db, userId, { isin: ISIN });
  await refreshCosts(db, {
    client: reply(answer(0)),
    fetchImpl: page(`${ISIN} TER 0 %`),
    now: NOW,
  });
  expect((await stored(db, fund.id))?.ongoingChargeBp).toBeNull();
});

test("a failed re-check keeps a verified fee and its source, only bumping checkedAt", async () => {
  const { db, userId } = await setup();
  const fund = await seedFund(db, userId, { isin: ISIN });
  await db
    .insert(instrumentCosts)
    .values({
      instrumentId: fund.id,
      ongoingChargeBp: 20,
      sourceUrl: URL_OK,
      checkedAt: NOW - 400 * DAY,
      source: "ai",
    })
    .run();
  await refreshCosts(db, { client: reply(answer(null, null)), fetchImpl: page(""), now: NOW });
  expect(await stored(db, fund.id)).toEqual({
    instrumentId: fund.id,
    ongoingChargeBp: 20,
    sourceUrl: URL_OK,
    checkedAt: NOW,
    source: "ai",
  });
});

test("due funds are asked never-checked first, then oldest", async () => {
  const { db, userId } = await setup();
  const old = await seedFund(db, userId, { isin: "FI0000000011", name: "Old" });
  const older = await seedFund(db, userId, { isin: "FI0000000012", name: "Older" });
  await seedFund(db, userId, { isin: "FI0000000013", name: "Never" });
  await seedFund(db, userId, { isin: "FI0000000014", name: "Never2" });
  await db
    .insert(instrumentCosts)
    .values([
      {
        instrumentId: old.id,
        ongoingChargeBp: null,
        sourceUrl: null,
        checkedAt: NOW - 40 * DAY,
        source: "ai",
      },
      {
        instrumentId: older.id,
        ongoingChargeBp: null,
        sourceUrl: null,
        checkedAt: NOW - 90 * DAY,
        source: "ai",
      },
    ])
    .run();
  const client = reply(answer(null, null));
  await refreshCosts(db, { client, fetchImpl: page(""), now: NOW });
  const names = client.asked.map((turn) => JSON.parse(String(turn.messages.at(-1)?.content)).name);
  expect(names).toEqual(["Never", "Never2", "Older"]);
});

test("setting your own fee refuses an unknown id and a stock", async () => {
  const { db, userId } = await setup();
  const stock = await seedFund(db, userId, { isin: "FI0000000015", kind: "stock" });
  await expect(setOwnCharge(db, 999_999, 20, NOW)).rejects.toMatchObject({ status: 404 });
  await expect(setOwnCharge(db, stock.id, 20, NOW)).rejects.toMatchObject({ status: 400 });
});

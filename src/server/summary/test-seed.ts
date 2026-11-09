import { eq } from "drizzle-orm";

import { EUR } from "../../core/money.ts";
import { CreateAccount, openAccount } from "../accounts.ts";
import { db } from "../db/index.ts";
import { imports, instruments, prices, transactions, user } from "../db/schema.ts";
import { addInstrument } from "../instruments/store.ts";

export const DAY_MS = 86_400_000;
export const daysAgo = (now: Date, days: number): string =>
  new Date(now.getTime() - days * DAY_MS).toISOString().slice(0, 10);

export const newUser = async (): Promise<string> => {
  const id = crypto.randomUUID();
  await db
    .insert(user)
    .values({
      id,
      name: "Test",
      email: `${id}@example.com`,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();
  return id;
};

export const bankAccount = async (userId: string): Promise<number> =>
  (
    await openAccount(
      db,
      userId,
      CreateAccount.parse({ name: "Bank", broker: "op", kind: "bank", accountType: "current" }),
    )
  ).id;

export const spend = async (accountId: number, note: string, minor: number, tradeDate: string) => {
  await db
    .insert(transactions)
    .values({
      accountId,
      instrumentId: null,
      type: "WITHDRAWAL",
      tradeDate,
      quantity: 0,
      unitPrice: null,
      amount: minor,
      fee: 0,
      tax: 0,
      currency: EUR,
      fxRateEur: 100_000_000,
      contentHash: crypto.randomUUID(),
      note,
    })
    .run();
};

/** `units` whole units bought on `buyDate` at `cents` each; `closes` are [date, cents] price points. */
export const holding = async (
  userId: string,
  args: {
    name: string;
    units: number;
    cents: number;
    buyDate: string;
    closes: readonly (readonly [string, number])[];
    lookupStatus?: "ok" | "pending" | "attention";
    createdDaysAgo?: number;
    now?: Date;
  },
): Promise<number> => {
  const accountId = (
    await openAccount(db, userId, CreateAccount.parse({ name: "Nordnet", broker: "nordnet" }))
  ).id;
  const isin = `XX${crypto.randomUUID().replace(/-/g, "").toUpperCase().slice(0, 9)}0`;
  const created = await addInstrument(db, {
    isin,
    ticker: "TST",
    name: args.name,
    kind: "stock",
    currency: EUR,
    priceSource: "manual",
    sourceKey: isin,
    lookupStatus: args.lookupStatus ?? "ok",
  });
  if (args.createdDaysAgo !== undefined) {
    await db
      .update(instruments)
      .set({ createdAt: new Date(Date.now() - args.createdDaysAgo * DAY_MS) })
      .where(eq(instruments.id, created.id))
      .run();
  }
  await db
    .insert(transactions)
    .values({
      accountId,
      instrumentId: created.id,
      type: "BUY",
      tradeDate: args.buyDate,
      quantity: args.units * 1_000_000,
      unitPrice: args.cents,
      amount: -(args.units * args.cents),
      fee: 0,
      tax: 0,
      currency: EUR,
      fxRateEur: 100_000_000,
      contentHash: crypto.randomUUID(),
    })
    .run();
  await db
    .insert(prices)
    .values(
      args.closes.map(([date, close]) => ({
        instrumentId: created.id,
        date,
        close,
        currency: EUR,
        source: "manual",
        fetchedAt: new Date(),
      })),
    )
    .run();
  return created.id;
};

export const committedImport = async (
  userId: string,
  createdDaysAgo: number,
  status: "committed" | "draft" | "undone" = "committed",
) => {
  await db
    .insert(imports)
    .values({
      userId,
      kind: "csv",
      filename: "x.csv",
      sha256: crypto.randomUUID(),
      status,
      createdAt: new Date(Date.now() - createdDaysAgo * DAY_MS),
    })
    .run();
};

export const deposit = async (userId: string, minor: number, tradeDate: string) => {
  const accountId = (
    await openAccount(db, userId, CreateAccount.parse({ name: "Nordnet", broker: "nordnet" }))
  ).id;
  await db
    .insert(transactions)
    .values({
      accountId,
      instrumentId: null,
      type: "DEPOSIT",
      tradeDate,
      quantity: 0,
      unitPrice: null,
      amount: minor,
      fee: 0,
      tax: 0,
      currency: EUR,
      fxRateEur: 100_000_000,
      contentHash: crypto.randomUUID(),
    })
    .run();
};

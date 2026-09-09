import { expect, test } from "vitest";

import { EUR } from "../../core/money.ts";
import { accounts, transactions, user } from "../db/schema.ts";
import { testDb } from "../db/test-db.ts";
import { commitBankStatement } from "./bank-commit.ts";
import type { BankRow } from "./bank-statement.ts";

// A year of card rows is well over a thousand, and D1 caps the parameters one
// statement may bind. The duplicate lookup has to survive that, so this file
// commits a statement far past the cap and then re-commits it.

const seed = async () => {
  const { db } = await testDb();
  await db
    .insert(user)
    .values({
      id: "u1",
      name: "Testi",
      email: "t@example.com",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();
  const account = await db
    .insert(accounts)
    .values({ userId: "u1", name: "Käyttötili", broker: "op", baseCurrency: EUR })
    .returning()
    .get();
  return { db, accountId: account.id };
};

const ROWS = 500;

const rows: readonly BankRow[] = Array.from({ length: ROWS }, (_, i) => ({
  line: i + 1,
  date: "2026-01-01",
  amount: BigInt(-100 - i),
  type: "WITHDRAWAL",
  note: `Osto ${i}`,
  counterparty: "",
  externalId: `2026010150000000000${String(i).padStart(4, "0")}`,
}));

test("commits and then de-duplicates a statement past D1's parameter cap", async () => {
  const { db, accountId } = await seed();
  const args = { userId: "u1", accountId, filename: "tiliote.csv", sha256: "abc", rows };

  const first = await commitBankStatement(db, args);
  expect(first.inserted).toBe(ROWS);
  expect(first.skipped).toBe(0);

  const second = await commitBankStatement(db, { ...args, sha256: "def" });
  expect(second.inserted).toBe(0);
  expect(second.skipped).toBe(ROWS);

  const stored = await db.select({ id: transactions.id }).from(transactions).all();
  expect(stored).toHaveLength(ROWS);
});

// A row's identity has to survive the two ways one file names two different
// transactions the same. Both cost real money: the row is dropped as a
// duplicate, and the account's balance then disagrees with the statement.

const twice = (over: Partial<BankRow>): readonly BankRow[] => [
  {
    line: 10,
    date: "2026-02-01",
    amount: -150_000n,
    type: "WITHDRAWAL",
    note: "Vuokra",
    counterparty: "Vuokranantaja",
    externalId: null,
    ...over,
  },
  {
    line: 20,
    date: "2026-02-01",
    amount: -150_000n,
    type: "WITHDRAWAL",
    note: "Vuokra",
    counterparty: "Vuokranantaja",
    externalId: null,
    ...over,
  },
];

test("keeps both rows when one file prints the same reference on two of them", async () => {
  const { db, accountId } = await seed();
  // An LEI or a payer's identifier repeats across every payment to one company;
  // a recipe that captures it as the archive id hands two rows the same id.
  const shared = twice({ externalId: "743700AAAAAAAAAAAA55" });
  const args = { userId: "u1", accountId, filename: "tiliote.pdf", sha256: "abc", rows: shared };

  const first = await commitBankStatement(db, args);
  expect(first.inserted).toBe(2);
  expect(first.skipped).toBe(0);

  const second = await commitBankStatement(db, { ...args, sha256: "def" });
  expect(second.inserted).toBe(0);
  expect(second.skipped).toBe(2);

  const stored = await db.select({ amount: transactions.amount }).from(transactions).all();
  expect(stored).toHaveLength(2);
});

test("keeps both rows when one file prints the same payment twice with no reference", async () => {
  const { db, accountId } = await seed();
  const args = { userId: "u1", accountId, filename: "tiliote.pdf", sha256: "abc", rows: twice({}) };

  const first = await commitBankStatement(db, args);
  expect(first.inserted).toBe(2);

  const second = await commitBankStatement(db, { ...args, sha256: "def" });
  expect(second.inserted).toBe(0);
  expect(second.skipped).toBe(2);

  const stored = await db.select({ amount: transactions.amount }).from(transactions).all();
  expect(stored).toHaveLength(2);
});

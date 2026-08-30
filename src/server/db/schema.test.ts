import { spawnSync } from "node:child_process";
import { test, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { getTableConfig, type AnySQLiteTable } from "drizzle-orm/sqlite-core";
import { EUR } from "../../core/money";
import { getDb, testDb } from "./index";
import {
  account,
  accounts,
  allocationTargets,
  fxRates,
  imports,
  instruments,
  priceFetchLog,
  prices,
  session,
  snapshotRows,
  snapshots,
  spendingRules,
  transactions,
  user,
} from "./schema";

const seedUser = (db: ReturnType<typeof testDb>["db"], id: string) => {
  db.insert(user)
    .values({
      id,
      name: "Test User",
      email: `${id}@example.com`,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();
};

/**
 * drizzle-orm@1.0.0-rc.5 wraps driver errors in `DrizzleQueryError`, whose
 * `.message` is just "Failed query: <sql>" — the underlying SQLite reason
 * (e.g. "UNIQUE constraint failed") lives on `.cause`. Bun's `toThrow`
 * matches `.message`, so assertions on the SQLite-level reason must go
 * through this helper instead.
 */
const causeMessage = (thrower: () => void): string => {
  try {
    thrower();
  } catch (error) {
    const cause = error instanceof Error ? error.cause : undefined;
    if (cause instanceof Error) return cause.message;
    throw new Error("Expected a driver error with a `cause`", { cause: error });
  }
  throw new Error("Expected function to throw");
};

test("applies migrations to a fresh in-memory database", () => {
  const { db } = testDb();
  expect(db.select().from(accounts).all()).toEqual([]);
});

test("stores money as integer minor units and quantity scaled by 1e6", () => {
  const { db } = testDb();
  seedUser(db, "u1");
  const [acct] = db
    .insert(accounts)
    .values({
      userId: "u1",
      name: "Nordnet AOT",
      broker: "nordnet",
      baseCurrency: EUR,
    })
    .returning()
    .all();
  const [nokia] = db
    .insert(instruments)
    .values({
      isin: "FI0009000681",
      ticker: "NOKIA.HE",
      name: "Nokia",
      kind: "stock",
      currency: EUR,
      priceSource: "yahoo",
      sourceKey: "NOKIA.HE",
    })
    .returning()
    .all();

  db.insert(transactions)
    .values({
      accountId: acct!.id,
      instrumentId: nokia!.id,
      type: "BUY",
      tradeDate: "2025-01-10",
      quantity: 10_000_000,
      unitPrice: 10_00,
      amount: -100_00,
      fee: 3_00,
      tax: 0,
      currency: EUR,
      fxRateEur: 100_000_000,
      contentHash: "abc",
      externalId: null,
      importId: null,
    })
    .run();

  const [row] = db.select().from(transactions).where(eq(transactions.accountId, acct!.id)).all();
  expect(row!.quantity).toBe(10_000_000);
  expect(row!.amount).toBe(-10000);
  expect(row!.fxRateEur).toBe(100_000_000);
});

test("rejects a duplicate content hash within one account", () => {
  const { db } = testDb();
  seedUser(db, "u1");
  const [acct] = db
    .insert(accounts)
    .values({
      userId: "u1",
      name: "OP",
      broker: "op",
      baseCurrency: EUR,
    })
    .returning()
    .all();
  const row = {
    accountId: acct!.id,
    instrumentId: null,
    type: "DEPOSIT" as const,
    tradeDate: "2025-01-01",
    quantity: 0,
    unitPrice: null,
    amount: 500_00,
    fee: 0,
    tax: 0,
    currency: EUR,
    fxRateEur: 100_000_000,
    contentHash: "dup",
    externalId: null,
    importId: null,
  };
  db.insert(transactions).values(row).run();
  expect(causeMessage(() => db.insert(transactions).values(row).run())).toMatch(/UNIQUE/i);
});

test("enforces foreign keys", () => {
  const { db } = testDb();
  const message = causeMessage(() =>
    db
      .insert(transactions)
      .values({
        accountId: 999,
        instrumentId: null,
        type: "DEPOSIT",
        tradeDate: "2025-01-01",
        quantity: 0,
        unitPrice: null,
        amount: 1,
        fee: 0,
        tax: 0,
        currency: EUR,
        fxRateEur: 100_000_000,
        contentHash: "x",
        externalId: null,
        importId: null,
      })
      .run(),
  );
  expect(message).toMatch(/FOREIGN KEY/i);
});

test("declares both transaction unique constraints and the account/date index", () => {
  const config = getTableConfig(transactions);
  const uniqueNames = config.uniqueConstraints.map((uq) => uq.name).sort();
  expect(uniqueNames).toEqual(["txn_external_uq", "txn_hash_uq"]);
  const indexNames = config.indexes.map((idx) => idx.config.name).sort();
  expect(indexNames).toEqual(["txn_account_date_idx", "txn_import_idx"]);
});

test("declares one spending rule per pattern per user", () => {
  const config = getTableConfig(spendingRules);
  const constraint = config.uniqueConstraints[0];

  // addRules checks this before inserting, but the constraint is what holds if
  // two imports classify at the same time: without it the assistant could add a
  // second rule for a pattern the owner had already answered, and which one
  // applied would come down to row order.
  expect(config.uniqueConstraints).toHaveLength(1);
  expect(constraint?.name).toBe("spending_rule_uq");
  expect(constraint?.columns.map((column) => column.name)).toEqual(["user_id", "pattern"]);
});

test("declares the composite primary keys on prices and fx_rates", () => {
  const priceKey = getTableConfig(prices).primaryKeys[0];
  expect(priceKey?.columns.map((c) => c.name)).toEqual(["instrument_id", "date"]);
  const fxKey = getTableConfig(fxRates).primaryKeys[0];
  expect(fxKey?.columns.map((c) => c.name)).toEqual(["date", "currency"]);
});

/** Resolves every `.references(() => target.col)` on a table to a plain, comparable shape. */
const fkTargets = (table: AnySQLiteTable) =>
  getTableConfig(table)
    .foreignKeys.map((fk) => {
      const { columns, foreignTable, foreignColumns } = fk.reference();
      return {
        column: columns[0]!.name,
        targetTable: getTableConfig(foreignTable).name,
        targetColumn: foreignColumns[0]!.name,
      };
    })
    .sort((a, b) => a.column.localeCompare(b.column));

test("wires every foreign key to its intended target table and column", () => {
  expect(fkTargets(session)).toEqual([
    { column: "user_id", targetTable: "user", targetColumn: "id" },
  ]);
  expect(fkTargets(account)).toEqual([
    { column: "user_id", targetTable: "user", targetColumn: "id" },
  ]);
  expect(fkTargets(accounts)).toEqual([
    { column: "user_id", targetTable: "user", targetColumn: "id" },
  ]);
  expect(fkTargets(imports)).toEqual([
    { column: "user_id", targetTable: "user", targetColumn: "id" },
  ]);
  expect(fkTargets(transactions)).toEqual([
    { column: "account_id", targetTable: "accounts", targetColumn: "id" },
    { column: "import_id", targetTable: "imports", targetColumn: "id" },
    { column: "instrument_id", targetTable: "instruments", targetColumn: "id" },
  ]);
  expect(fkTargets(snapshots)).toEqual([
    { column: "account_id", targetTable: "accounts", targetColumn: "id" },
    { column: "import_id", targetTable: "imports", targetColumn: "id" },
  ]);
  expect(fkTargets(snapshotRows)).toEqual([
    { column: "instrument_id", targetTable: "instruments", targetColumn: "id" },
    { column: "snapshot_id", targetTable: "snapshots", targetColumn: "id" },
  ]);
  expect(fkTargets(prices)).toEqual([
    { column: "instrument_id", targetTable: "instruments", targetColumn: "id" },
  ]);
  expect(fkTargets(priceFetchLog)).toEqual([
    { column: "instrument_id", targetTable: "instruments", targetColumn: "id" },
  ]);
});

test("declares the accounts.user_id index and the price_fetch_log.run_at index", () => {
  const accountsIndexNames = getTableConfig(accounts).indexes.map((idx) => idx.config.name);
  expect(accountsIndexNames).toEqual(["accounts_user_idx"]);
  const logIndexNames = getTableConfig(priceFetchLog).indexes.map((idx) => idx.config.name);
  expect(logIndexNames).toEqual(["price_log_run_idx"]);
});

test("getDb memoizes a single shared handle across calls", () => {
  const originalPath = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = ":memory:";
  try {
    const first = getDb();
    const second = getDb();
    expect(second).toBe(first);
    expect(first.sqlite.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  } finally {
    if (originalPath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = originalPath;
  }
});

// resetDbHandleForTests() has no callers left in this suite: test-setup.ts
// (a bunfig.toml `[test] preload` script) pins the one shared handle
// before any test file runs, and no file may reset it afterward without
// desyncing auth.ts/accounts.ts/instruments.ts from each other again (see
// test-setup.ts's comment and task-9-report.md's fix-up report for the bug
// that caused). So this runs the reset in a genuinely separate child
// process instead, where resetting is safe because nothing else shares
// that process's handle.
test("resetDbHandleForTests() forces the next getDb() call to open a new handle", () => {
  const dbIndexPath = new URL("./index.ts", import.meta.url).pathname;
  const script = `
    const { getDb, resetDbHandleForTests } = await import(${JSON.stringify(dbIndexPath)});
    process.env.DATABASE_PATH = ":memory:";
    const first = getDb();
    first.sqlite.exec("CREATE TABLE marker (id INTEGER)");
    resetDbHandleForTests();
    process.env.DATABASE_PATH = ":memory:";
    const second = getDb();
    const hasMarker = second.sqlite
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='marker'")
      .get();
    console.log(JSON.stringify({ sameHandle: second === first, hasMarker: hasMarker !== null }));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf-8",
  });
  expect(result.status).toBe(0);
  // SAFETY: the script above unconditionally prints exactly one JSON line
  // as its only stdout output, or the exit-code check above would already
  // have thrown.
  const parsed = JSON.parse(result.stdout.trim()) as {
    sameHandle: boolean;
    hasMarker: boolean;
  };
  expect(parsed.sameHandle).toBe(false);
  expect(parsed.hasMarker).toBe(false);
});

test("declares one target per slice per dimension per user", () => {
  // Asserted on the declaration, not only through an insert: the constraint is
  // what stops a half-applied write leaving two targets for one slice, and a
  // migration that quietly dropped it would still pass the insert test on a
  // database created before the drop.
  const config = getTableConfig(allocationTargets);

  expect(config.uniqueConstraints.map((uq) => uq.columns.map((c) => c.name).join(","))).toEqual([
    "user_id,dimension,key",
  ]);
});

test("a user cannot hold two targets for the same slice", () => {
  const { db } = testDb();
  seedUser(db, "targets-user");
  const row = {
    userId: "targets-user",
    dimension: "kind" as const,
    key: "stock",
    weightBp: 6000,
  };
  db.insert(allocationTargets).values(row).run();

  // A second target for the same slice is a contradiction, not an update: a
  // set is replaced wholesale, never accumulated into, so two rows for one
  // slice can only mean a half-applied write.
  expect(() => db.insert(allocationTargets).values(row).run()).toThrow();
});

test("the same slice can be targeted on two different dimensions", () => {
  const { db } = testDb();
  seedUser(db, "two-dimensions");
  db.insert(allocationTargets)
    .values({ userId: "two-dimensions", dimension: "kind", key: "stock", weightBp: 10000 })
    .run();

  // "stock" as a kind and "stock" as an account name are different slices that
  // happen to share a key, so the index has to include the dimension.
  expect(() =>
    db
      .insert(allocationTargets)
      .values({ userId: "two-dimensions", dimension: "account", key: "stock", weightBp: 10000 })
      .run(),
  ).not.toThrow();
});

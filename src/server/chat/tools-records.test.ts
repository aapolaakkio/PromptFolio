import { describe, expect, test } from "vitest";

import { EUR } from "../../core/money.ts";
import { addCashEntry } from "../cash-entries.ts";
import { db } from "../db/index.ts";
import { conversations, imports } from "../db/schema.ts";
import { createSnapshot } from "../snapshot/service.ts";
import { bankAccount, seed } from "./proposal-test-kit.ts";
import { buildRecordTools } from "./tools-records.ts";
import { buildChatTools } from "./tools.ts";

// The ids proposals need, read from the caller's own records only; nothing here writes.

const run = async (userId: string, name: string, args: Record<string, number> = {}) => {
  const tool = buildRecordTools(db, userId).find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`no tool ${name}`);
  return JSON.stringify(await tool.run(tool.schema.parse(args)));
};

describe("record tools", () => {
  test("list the caller's accounts, cash entries, statements, imports and conversations by id", async () => {
    const { userId, accountId, instrumentId } = await seed();
    const other = await seed();
    const bank = await bankAccount(userId);
    const entry = await addCashEntry(userId, {
      accountId: bank,
      type: "DEPOSIT",
      tradeDate: "2026-11-03",
      amount: "500",
      currency: EUR,
    });
    const statement = await createSnapshot(userId, {
      accountId,
      asOf: "2026-10-31",
      source: "manual",
      rows: [{ instrumentId, quantity: "12" }],
    });
    await db
      .insert(imports)
      .values({
        userId,
        kind: "csv_bank",
        filename: "tiliote FI21 1234 5600 0007 85.csv",
        sha256: crypto.randomUUID(),
        status: "committed",
      })
      .run();
    await db.insert(conversations).values({ userId, title: "Tax question" }).run();

    const listed = [
      await run(userId, "get_accounts"),
      await run(userId, "get_cash_entries", { accountId: bank }),
      await run(userId, "get_snapshots", { accountId }),
      await run(userId, "get_imports"),
      await run(userId, "get_conversations"),
    ];

    expect(listed[0]).toContain(`"id":${bank}`);
    expect(listed[0]).not.toContain(String(other.accountId) + ',"name"');
    expect(listed[1]).toContain(`"id":${entry.id}`);
    expect(listed[1]).toContain('"amount":"500.00"');
    expect(listed[2]).toContain(`"id":${statement.id}`);
    expect(listed[2]).toContain(`"instrumentId":${instrumentId}`);
    expect(listed[3]).toContain("tiliote");
    expect(listed[3]).not.toContain("1234 5600");
    expect(listed[4]).toContain("Tax question");
  });

  test("someone else's account is refused", async () => {
    const { userId } = await seed();
    const other = await seed();
    await expect(run(userId, "get_cash_entries", { accountId: other.accountId })).rejects.toThrow(
      "Account not found",
    );
  });
});

describe("account names", () => {
  test("reach the model with any account number masked", async () => {
    const { userId } = await seed();
    const bank = await bankAccount(userId, "OP 1234567-8");
    await addCashEntry(userId, {
      accountId: bank,
      type: "DEPOSIT",
      tradeDate: "2026-01-02",
      amount: "50",
      currency: EUR,
    });
    const tools = [...buildRecordTools(db, userId), ...buildChatTools(db, userId)];
    const read = async (name: string) => {
      const tool = tools.find((candidate) => candidate.name === name);
      if (tool === undefined) throw new Error(`no tool ${name}`);
      return JSON.stringify(await tool.run(tool.schema.parse({})));
    };

    for (const name of ["get_accounts", "get_cash"]) {
      const text = await read(name);
      expect(text).toContain("OP …");
      expect(text).not.toContain("1234567");
    }
  });
});

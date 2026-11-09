import { eq } from "drizzle-orm";
import { describe, expect, test } from "vitest";

import { db } from "../db/index.ts";
import { snapshots, transactions } from "../db/schema.ts";
import { adjustSnapshotRow, createSnapshot } from "../snapshot/service.ts";
import { buy, onlyCard, propose, seed } from "./proposal-test-kit.ts";

// A typed statement and a reconcile adjustment: each card names every row and figure it would store.

describe("propose_snapshot", () => {
  test("names the account, date and every row, and stores no statement", async () => {
    const { userId, accountId, instrumentId, isin } = await seed();
    const card = onlyCard(
      await propose(userId, "propose_snapshot", {
        accountId,
        asOf: "2026-10-31",
        source: "manual",
        rows: [{ instrumentId, quantity: "12,5", nav: "10.20", marketValue: "127.50" }],
        statedTotalEur: "127.50",
      }),
    );

    expect(card.action).toBe("snapshot");
    expect(card.facts).toEqual([
      { kind: "text", label: "Account", text: `Nordnet (account #${accountId})` },
      { kind: "text", label: "Statement date", text: "2026-10-31" },
      { kind: "text", label: "Source", text: "Typed by hand" },
      { kind: "text", label: `Acme Fund (${isin})`, text: "12.5 units" },
      { kind: "money", label: "NAV", amount: "10.20", currency: "EUR" },
      { kind: "money", label: "Market value", amount: "127.50", currency: "EUR" },
      { kind: "money", label: "Statement total", amount: "127.50", currency: "EUR" },
    ]);
    expect(
      await db.select().from(snapshots).where(eq(snapshots.accountId, accountId)).all(),
    ).toEqual([]);
  });

  test("rows that do not add up to the stated total, a read source and a foreign account are refused", async () => {
    const { userId, accountId, instrumentId } = await seed();
    const other = await seed();
    const row = { instrumentId, quantity: "1", marketValue: "10" };

    const total = await propose(userId, "propose_snapshot", {
      accountId,
      asOf: "2026-10-31",
      source: "manual",
      rows: [row],
      statedTotalEur: "11",
    });
    expect(total.toolResult).toContain("do not match the statement total");
    const pdf = await propose(userId, "propose_snapshot", {
      accountId,
      asOf: "2026-10-31",
      source: "pdf",
      rows: [row],
    });
    expect(pdf.toolResult).toContain("typed by hand");
    const foreign = await propose(userId, "propose_snapshot", {
      accountId: other.accountId,
      asOf: "2026-10-31",
      source: "manual",
      rows: [row],
    });
    expect(foreign.toolResult).toContain("Account not found");
    const long = await propose(userId, "propose_snapshot", {
      accountId,
      asOf: "2026-10-31",
      source: "manual",
      rows: Array.from({ length: 61 }, (_, index) => ({ instrumentId: index + 1, quantity: "1" })),
    });
    expect(long.toolResult).toContain("at most 60 rows");
    expect([...total.proposals, ...pdf.proposals, ...foreign.proposals, ...long.proposals]).toEqual(
      [],
    );
  });
});

describe("propose_snapshot_adjust", () => {
  const withGap = async () => {
    const owner = await seed();
    const statement = await createSnapshot(owner.userId, {
      accountId: owner.accountId,
      asOf: "2026-10-31",
      source: "manual",
      rows: [{ instrumentId: owner.instrumentId, quantity: "12" }],
    });
    return { ...owner, snapshotId: statement.id };
  };

  test("names the direction, quantity, date and cost it would book, and books nothing", async () => {
    const { userId, accountId, instrumentId, isin, snapshotId } = await withGap();
    const card = onlyCard(
      await propose(userId, "propose_snapshot_adjust", { snapshotId, instrumentId, costEur: "20" }),
    );

    expect(card.facts).toEqual([
      {
        kind: "text",
        label: "Statement",
        text: `Nordnet (account #${accountId}), statement of 2026-10-31 (#${snapshotId})`,
      },
      { kind: "text", label: "Instrument", text: `Acme Fund (${isin})` },
      { kind: "text", label: "Direction", text: "Units in (transfer in)" },
      { kind: "text", label: "Quantity", text: "2 units" },
      { kind: "text", label: "Date", text: "2026-10-31" },
      { kind: "money", label: "Cost basis", amount: "20.00", currency: "EUR" },
    ]);
    expect(card.input).toEqual({
      snapshotId,
      instrumentId,
      costEur: "20",
      expectQuantity: "2.000000",
    });
    const booked = await db
      .select()
      .from(transactions)
      .where(eq(transactions.accountId, accountId))
      .all();
    expect(booked.map((row) => row.type)).toEqual(["BUY"]);
  });

  test("a ledger changed after the card was made is refused on Confirm", async () => {
    const { userId, accountId, instrumentId, snapshotId } = await withGap();
    const card = onlyCard(
      await propose(userId, "propose_snapshot_adjust", { snapshotId, instrumentId, costEur: "20" }),
    );
    if (card.action !== "snapshot_adjust") throw new Error("wrong card");
    await buy(accountId, instrumentId, "2026-05-01");

    await expect(adjustSnapshotRow(userId, snapshotId, card.input)).rejects.toThrow(
      "changed since the card",
    );
  });

  test("units arriving need a cost, and someone else's statement is refused", async () => {
    const { userId, instrumentId, snapshotId } = await withGap();
    const other = await withGap();

    const noCost = await propose(userId, "propose_snapshot_adjust", { snapshotId, instrumentId });
    expect(noCost.toolResult).toContain("Cost basis is required");
    const foreign = await propose(userId, "propose_snapshot_adjust", {
      snapshotId: other.snapshotId,
      instrumentId: other.instrumentId,
      costEur: "20",
    });
    expect(foreign.toolResult).toContain("Snapshot not found");
    expect([...noCost.proposals, ...foreign.proposals]).toEqual([]);
  });
});

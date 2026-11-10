import { desc, eq } from "drizzle-orm";
import { z } from "zod";

import { listAccounts } from "../accounts.ts";
import { listCashEntries } from "../cash-entries.ts";
import { conversations, imports } from "../db/schema.ts";
import { listSnapshots, reconcileSnapshot } from "../snapshot/service.ts";
import { maskAccountNumbers, maskTypedText } from "./mask.ts";
import type { ChatTool, Db, ToolResult } from "./tool-types.ts";

const NoArgs = z.object({}).strict();
const ForAccount = z.object({ accountId: z.number().int().positive() }).strict();

/** Token budget: the newest first, and the tool says when it cut. */
const MAX_LISTED = 30;

const capped = <T>(rows: readonly T[]) => ({
  rows: rows.slice(0, MAX_LISTED),
  truncated: rows.length > MAX_LISTED,
});

/**
 * The ids the proposal tools take, from the caller's own records. Only what identifies a thing to the
 * owner: no notes, and file names with account numbers masked.
 */
export const buildRecordTools = (db: Db, userId: string): ChatTool[] => [
  {
    name: "get_accounts",
    description:
      "The owner's accounts: id, name, broker, kind (brokerage or bank), type, base currency and " +
      "a fixed-term account's maturity date and interest rate.",
    schema: NoArgs,
    run: async (input): Promise<ToolResult> => {
      NoArgs.parse(input);
      return {
        accounts: (await listAccounts(db, userId)).map((account) => ({
          id: account.id,
          name: maskAccountNumbers(account.name),
          broker: account.broker,
          kind: account.kind,
          accountType: account.accountType,
          baseCurrency: account.baseCurrency,
          maturityDate: account.maturityDate,
          interestRatePercent:
            account.interestRateBp === null ? null : (account.interestRateBp / 100).toFixed(2),
        })),
      };
    },
  },
  {
    name: "get_cash_entries",
    description:
      "The cash entries typed by hand on one account (accountId from get_accounts), newest first: " +
      "id, type, date, amount (positive; the type gives the direction) and currency.",
    schema: ForAccount,
    run: async (input): Promise<ToolResult> => {
      const { accountId } = ForAccount.parse(input);
      const { rows, truncated } = capped((await listCashEntries(userId, accountId)).entries);
      return {
        entries: rows.map((entry) => ({
          id: entry.id,
          type: entry.type,
          date: entry.tradeDate,
          amount: entry.amount.replace("-", ""),
          currency: entry.currency,
        })),
        truncated,
      };
    },
  },
  {
    name: "get_snapshots",
    description:
      "The holdings statements of one account (accountId from get_accounts), newest first: id, " +
      "date, source and the rows that differ from the ledger (instrumentId, name, derived and " +
      "statement quantity, delta).",
    schema: ForAccount,
    run: async (input): Promise<ToolResult> => {
      const { accountId } = ForAccount.parse(input);
      const { rows, truncated } = capped([...(await listSnapshots(userId, accountId))].reverse());
      const statements = await Promise.all(
        rows.map(async (snapshot) => {
          const check = await reconcileSnapshot(userId, snapshot.id);
          return {
            id: snapshot.id,
            asOf: snapshot.asOf,
            source: snapshot.source,
            differences: check.rows
              .filter((row) => !row.withinTolerance)
              .map((row) => ({
                instrumentId: row.instrumentId,
                name: row.name,
                derived: row.derived,
                statement: row.snapshot,
                delta: row.delta,
              })),
          };
        }),
      );
      return { statements, truncated };
    },
  },
  {
    name: "get_imports",
    description:
      "The owner's imports, newest first: id, file name (account numbers masked), kind, status " +
      "(committed or undone), date and how many transactions it added.",
    schema: NoArgs,
    run: async (input): Promise<ToolResult> => {
      NoArgs.parse(input);
      const all = await db
        .select()
        .from(imports)
        .where(eq(imports.userId, userId))
        .orderBy(desc(imports.createdAt), desc(imports.id))
        .all();
      const { rows, truncated } = capped(all);
      return {
        imports: rows.map((row) => ({
          id: row.id,
          file: maskAccountNumbers(row.filename),
          kind: row.kind,
          status: row.status,
          date: row.createdAt.toISOString().slice(0, 10),
          transactions: row.insertedCount,
        })),
        truncated,
      };
    },
  },
  {
    name: "get_conversations",
    description: "The owner's chat conversations, newest first: id, title and date.",
    schema: NoArgs,
    run: async (input): Promise<ToolResult> => {
      NoArgs.parse(input);
      const all = await db
        .select()
        .from(conversations)
        .where(eq(conversations.userId, userId))
        .orderBy(desc(conversations.id))
        .all();
      const { rows, truncated } = capped(all);
      return {
        conversations: rows.map((row) => ({
          id: row.id,
          title: row.title === null ? null : maskTypedText(row.title),
          date: row.createdAt.toISOString().slice(0, 10),
        })),
        truncated,
      };
    },
  },
];

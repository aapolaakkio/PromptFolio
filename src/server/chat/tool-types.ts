import { z } from "zod";

import type { Dimension } from "../../core/allocation";
import type { IsoDate } from "../../core/types";
import type { getDb } from "../db";

export type Db = ReturnType<typeof getDb>["db"];

export const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Päivämäärän on oltava muotoa YYYY-MM-DD");

export const today = (): IsoDate => new Date().toISOString().slice(0, 10);

/**
 * How much of the ledger one tool call may hand the model.
 *
 * Both are token budgets, not display limits: a tool result stays in the
 * conversation and is re-sent with every later turn, so an over-generous
 * default is paid for again and again. Each tool says when it truncated, and
 * `limit` lets the model ask for more when a question needs it.
 */
export const MAX_SERIES_POINTS = 60;
export const DEFAULT_TXN_LIMIT = 25;

/**
 * Every argument any tool accepts, in one type. Each tool still declares its
 * own strict schema -- that is what the model is shown and what rejects a
 * hallucinated parameter -- and re-parses its input; this shared type only
 * describes what a validated argument object can hold, so no tool's `run` has
 * to take `unknown`.
 */
export type ToolArgs = {
  readonly on?: string;
  readonly from?: string;
  readonly to?: string;
  readonly dimension?: Dimension;
  readonly groupBy?: "category" | "counterparty";
  readonly limit?: number;
  readonly operation?: "sum" | "subtract" | "multiply" | "divide" | "percent" | "average";
  readonly values?: readonly string[];
  readonly year?: number;
  /** The allocation dimension a drift question is asked on. */
  readonly by?: Dimension;
  /** One spending category to follow over time, by its key. */
  readonly category?: string;
  /** Money about to be paid in, as a decimal string. */
  readonly amountEur?: string;
  /** Free text matched against a transaction's own bank text. */
  readonly search?: string;
};

/** What a tool hands back: JSON, because that is what the model reads. */
export type JsonValue = string | number | boolean | null | readonly JsonValue[];
export type ToolResult = { readonly [key: string]: JsonValue | ToolResult | readonly ToolResult[] };

/**
 * The read-only tools the chat model may call (spec §8).
 *
 * Every one is a thin wrapper over the same `core` function the dashboard calls,
 * so chat and screen cannot disagree about a number. None of them writes, none
 * takes a user id from the model -- the caller binds that from the session, so a
 * question can never reach another household member's ledger however it is
 * phrased.
 *
 * Each result carries the date it was computed for and whether any part of it is
 * stale, because the model is instructed to state both and can only do that if
 * the tool tells it. Money and quantities cross as decimal strings, the same
 * wire rule the HTTP API follows: a model that receives a float is one rounding
 * away from quoting a number the ledger never held.
 */
export type ChatTool = {
  readonly name: string;
  readonly description: string;
  readonly schema: z.ZodType<ToolArgs>;
  readonly run: (input: ToolArgs) => ToolResult;
};

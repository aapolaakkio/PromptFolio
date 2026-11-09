import { z } from "zod";

import type { Dimension } from "../../core/allocation.ts";
import type { IsoDate } from "../../core/types.ts";
import type { ChartSpec, ChatChart } from "./chart-schema.ts";
import type { ForecastOverrides } from "./forecast-overrides.ts";
import type { Proposal } from "./proposal-schema.ts";

export type { Db } from "../db/index.ts";

export const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in the form YYYY-MM-DD");

export const today = (): IsoDate => new Date().toISOString().slice(0, 10);

/** Token budgets, not display limits: a tool result is re-sent every later turn. Tools say when they truncated; `limit` asks for more. */
export const MAX_SERIES_POINTS = 60;
export const DEFAULT_TXN_LIMIT = 25;

// Each tool declares its own strict schema and re-parses; this type only avoids `unknown` in `run`.
export type ToolArgs = Partial<ChartSpec> & {
  readonly on?: string;
  readonly from?: string;
  readonly to?: string;
  readonly dimension?: Dimension;
  readonly groupBy?: "category" | "counterparty";
  readonly limit?: number;
  readonly operation?: "sum" | "subtract" | "multiply" | "divide" | "percent" | "average";
  readonly values?: readonly string[];
  readonly year?: number;
  readonly by?: Dimension;
  readonly category?: string;
  readonly amountEur?: string;
  readonly search?: string;
  readonly pattern?: string;
  readonly rules?: readonly { readonly pattern: string; readonly category: string }[];
  readonly instrumentId?: number;
  readonly date?: string;
  readonly price?: string;
  readonly accountId?: number;
  readonly type?: string;
  readonly tradeDate?: string;
  readonly amount?: string;
  readonly currency?: string;
  readonly note?: string;
  readonly targets?: readonly { readonly key: string; readonly weightPercent: string }[];
  readonly id?: number;
  readonly priceSource?: string;
  readonly sourceKey?: string;
  readonly mode?: "replace" | "add";
  readonly rows?: readonly { readonly instrumentId: number; readonly amountEur: string }[];
  readonly months?: number;
  readonly real?: boolean;
  readonly holdingIds?: readonly number[];
  readonly plan?: ForecastOverrides["plan"];
  readonly monthlyTotalEur?: number;
  readonly events?: ForecastOverrides["events"];
  readonly shocks?: ForecastOverrides["shocks"];
  readonly rates?: ForecastOverrides["rates"];
  readonly targetEur?: number;
  readonly byMonth?: number;
};

export type JsonValue = string | number | boolean | null | readonly JsonValue[];
export type ToolResult = { readonly [key: string]: JsonValue | ToolResult | readonly ToolResult[] };

/**
 * The tools the chat model may call. Only the three in `tools-rules.ts` write, and only classification.
 * Each wraps the same `core` function the dashboard calls, and the user id comes from the session,
 * never the model. Results carry their date and staleness; money and quantities are decimal strings.
 */
export type ChatTool = {
  readonly name: string;
  readonly description: string;
  readonly schema: z.ZodType<ToolArgs>;
  readonly run: (input: ToolArgs) => Promise<ToolResult>;
};

/** Validates and describes an owner action; writes nothing. A refusal throws, and its message goes back to the model. */
export type ProposalTool = {
  readonly name: string;
  readonly description: string;
  readonly schema: z.ZodType<ToolArgs>;
  readonly propose: (input: ToolArgs) => Promise<Proposal>;
};

/** Resolves a chart spec into app-computed data; the runner streams it and tells the model only a summary. */
export type ChartTool = {
  readonly name: string;
  readonly description: string;
  readonly schema: z.ZodType<ToolArgs>;
  readonly chart: (input: ToolArgs) => Promise<ChatChart>;
};

export type AnyTool = ChatTool | ProposalTool | ChartTool;

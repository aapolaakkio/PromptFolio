import { APIConnectionError } from "@anthropic-ai/sdk";
import { z } from "zod";

const TRANSIENT_NAMES = new Set(["AbortError", "TimeoutError"]);

const HasStatus = z.object({ status: z.number() });

const statusOf = (cause: Error): number | null => {
  const parsed = HasStatus.safeParse(cause);
  return parsed.success ? parsed.data.status : null;
};

/**
 * True for a failure worth trying again later: a network error, an abort or
 * timeout, HTTP 429, 5xx (Anthropic's 529 overloaded included). A refusal or a
 * 4xx is an answer, not a hiccup.
 */
export const isTransientFailure = (cause: unknown): boolean => {
  if (!(cause instanceof Error)) return false;
  if (cause instanceof TypeError || cause instanceof APIConnectionError) return true;
  if (TRANSIENT_NAMES.has(cause.name)) return true;
  const status = statusOf(cause);
  return status !== null && (status === 429 || status >= 500);
};

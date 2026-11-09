import { APIConnectionError, APIUserAbortError } from "@anthropic-ai/sdk";
import { z } from "zod";

const TRANSIENT_NAMES = new Set(["AbortError", "TimeoutError"]);

const HasStatus = z.object({ status: z.number() });

const statusOf = (cause: Error): number | null => {
  const parsed = HasStatus.safeParse(cause);
  return parsed.success ? parsed.data.status : null;
};

/**
 * A failure worth retrying later: network error, abort/timeout, 429, 5xx (529 included).
 * Refusals and 4xx are answers; a plain TypeError is a bug (the SDK reports network failures
 * as APIConnectionError), and a bug retried nightly would bill nightly.
 */
export const isTransientFailure = (cause: unknown): boolean => {
  if (!(cause instanceof Error)) return false;
  // APIUserAbortError is what the SDK throws when our own timeout signal fires.
  if (cause instanceof APIConnectionError || cause instanceof APIUserAbortError) return true;
  if (TRANSIENT_NAMES.has(cause.name)) return true;
  const status = statusOf(cause);
  return status !== null && (status === 429 || status >= 500);
};

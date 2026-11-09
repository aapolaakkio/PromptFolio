import { eq } from "drizzle-orm";

import type { Db } from "../db/index.ts";
import { yahooGate } from "../db/schema.ts";
import { urlOf, type FetchImpl } from "./types.ts";

const GATE_ID = 1;
const FIRST_BACKOFF_MS = 15 * 60_000;
const MAX_BACKOFF_MS = 6 * 60 * 60_000;

export class YahooPausedError extends Error {
  readonly until: number;

  constructor(until: number) {
    super(`Yahoo is paused until ${new Date(until).toISOString()}`);
    this.name = "YahooPausedError";
    this.until = until;
  }
}

const readGate = async (db: Db) =>
  (await db.select().from(yahooGate).where(eq(yahooGate.id, GATE_ID)).limit(1))[0];

const writeGate = async (
  db: Db,
  row: { readonly pausedUntil: number | null; readonly backoffMs: number },
): Promise<void> => {
  await db
    .insert(yahooGate)
    .values({ id: GATE_ID, ...row })
    .onConflictDoUpdate({ target: yahooGate.id, set: row })
    .run();
};

export const yahooPausedUntil = async (
  db: Db,
  now: () => number = Date.now,
): Promise<number | null> => {
  const until = (await readGate(db))?.pausedUntil ?? null;
  return until !== null && until > now() ? until : null;
};

const retryAfterMs = (res: Response, now: () => number): number | null => {
  const value = res.headers.get("Retry-After");
  if (value === null) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  const untilDate = Date.parse(value) - now();
  return Number.isFinite(untilDate) && untilDate > 0 ? untilDate : null;
};

/** Only Yahoo's own hosts are gated; OpenFIGI and op.fi have their own limits. */
const isYahoo = (input: string | URL | Request): boolean => {
  try {
    return new URL(urlOf(input)).hostname.endsWith(".finance.yahoo.com");
  } catch {
    return false;
  }
};

/** Yahoo answers 429 to a client that does not say who it is (verified 2026-11-09). The app's own name, not a browser's. */
const APP_USER_AGENT = "PromptFolio/1.0 (personal portfolio tracker)";

/** Every Yahoo request goes through this. A 429 means wait: never retried, nothing sent while paused. */
export const gatedFetch =
  (db: Db, fetchImpl: FetchImpl, now: () => number = Date.now): FetchImpl =>
  async (input, init) => {
    if (!isYahoo(input)) return await fetchImpl(input, init);

    const pausedUntil = await yahooPausedUntil(db, now);
    if (pausedUntil !== null) throw new YahooPausedError(pausedUntil);

    const headers = new Headers(init?.headers);
    headers.set("User-Agent", APP_USER_AGENT);
    const res = await fetchImpl(input, { ...init, headers });
    if (res.status !== 429) {
      await writeGate(db, { pausedUntil: null, backoffMs: 0 });
      return res;
    }

    const previous = (await readGate(db))?.backoffMs ?? 0;
    const backoffMs = Math.min(previous === 0 ? FIRST_BACKOFF_MS : previous * 2, MAX_BACKOFF_MS);
    const waitMs = retryAfterMs(res, now) ?? backoffMs;
    const until = now() + waitMs;
    await writeGate(db, { pausedUntil: until, backoffMs });
    throw new YahooPausedError(until);
  };

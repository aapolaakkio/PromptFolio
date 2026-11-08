import { eq } from "drizzle-orm";

import type { Db } from "../db/index.ts";
import { yahooGate } from "../db/schema.ts";
import type { FetchImpl } from "./types.ts";

const GATE_ID = 1;
const FIRST_BACKOFF_MS = 15 * 60_000;
const MAX_BACKOFF_MS = 6 * 60 * 60_000;

/** Thrown instead of a request while Yahoo has told us to wait. */
export class YahooPausedError extends Error {
  readonly until: number;

  constructor(until: number) {
    super(`Yahoo on tauolla ${new Date(until).toISOString()} asti`);
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

/** When the pause ends, or null when Yahoo may be asked now. */
export const yahooPausedUntil = async (
  db: Db,
  now: () => number = Date.now,
): Promise<number | null> => {
  const until = (await readGate(db))?.pausedUntil ?? null;
  return until !== null && until > now() ? until : null;
};

const retryAfterMs = (res: Response): number | null => {
  const seconds = Number(res.headers.get("Retry-After"));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
};

/**
 * Every Yahoo request goes through this. A 429 means wait: it is never retried,
 * and nothing is sent while the pause lasts.
 */
export const gatedFetch =
  (db: Db, fetchImpl: FetchImpl, now: () => number = Date.now): FetchImpl =>
  async (input, init) => {
    const pausedUntil = await yahooPausedUntil(db, now);
    if (pausedUntil !== null) throw new YahooPausedError(pausedUntil);

    const res = await fetchImpl(input, init);
    if (res.status !== 429) {
      await writeGate(db, { pausedUntil: null, backoffMs: 0 });
      return res;
    }

    const previous = (await readGate(db))?.backoffMs ?? 0;
    const backoffMs = Math.min(previous === 0 ? FIRST_BACKOFF_MS : previous * 2, MAX_BACKOFF_MS);
    const waitMs = retryAfterMs(res) ?? backoffMs;
    const until = now() + waitMs;
    await writeGate(db, { pausedUntil: until, backoffMs });
    throw new YahooPausedError(until);
  };

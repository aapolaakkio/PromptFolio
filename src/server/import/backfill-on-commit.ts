import type { Db } from "../db/index.ts";
import { backfillFxRates } from "../fx.ts";
import { backfillMany } from "../prices/refresh.ts";
import type { FetchImpl } from "../prices/types.ts";
import type { Draft } from "./map.ts";

/** Never rejects; callers must not await it (backfill can take years of fetches). Exported so tests can await. */
export const backfillCommittedInstruments = async (
  db: Db,
  draft: Draft,
  opts: { fetchImpl?: FetchImpl } = {},
): Promise<void> => {
  const instrumentIds = [
    ...new Set(draft.txns.flatMap((row) => (row.instrumentId === null ? [] : [row.instrumentId]))),
  ];
  if (instrumentIds.length > 0) {
    await backfillMany(db, instrumentIds, opts);
  }
  try {
    await backfillFxRates(db, opts);
  } catch (cause) {
    console.error("FX history backfill after import failed unexpectedly", cause);
  }
};

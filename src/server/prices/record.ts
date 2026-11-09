import type { Db } from "../db/index.ts";
import { instruments, priceFetchLog } from "../db/schema.ts";
import type { FetchedPrice } from "./types.ts";
import { MAX_PLAUSIBLE_RATIO, writePrices } from "./write.ts";

export const logAttempt = async (
  db: Db,
  args: {
    readonly source: string;
    readonly instrumentId: number;
    readonly ok: boolean;
    readonly message: string;
  },
): Promise<void> => {
  await db
    .insert(priceFetchLog)
    .values({
      source: args.source,
      instrumentId: args.instrumentId,
      runAt: new Date(),
      ok: args.ok,
      message: args.message,
    })
    .run();
};

export type Priced = Pick<typeof instruments.$inferSelect, "id" | "priceSource" | "sourceKey">;

/** Writes one instrument's fetched points and logs it; true when ok. An implausible point counts as a failure: the fetch worked, the data was not trusted. */
export const recordPoints = async (
  db: Db,
  instrument: Priced,
  points: readonly FetchedPrice[],
): Promise<boolean> => {
  const sourceId = instrument.priceSource;
  const { written, rejectedImplausible, reBaselined } = await writePrices(
    db,
    instrument.id,
    sourceId,
    points,
  );

  if (reBaselined > 0) {
    // Loud on purpose: an implausible price was just confirmed as a permanent change.
    const message =
      `${written} price points saved, ${reBaselined} of them ` +
      `REBASED after a confirmed permanent change` +
      (rejectedImplausible > 0 ? ` (${rejectedImplausible} still rejected)` : "");
    console.warn(`Price series rebased: ${sourceId} for instrument ${instrument.id}`);
    await logAttempt(db, { source: sourceId, instrumentId: instrument.id, ok: true, message });
    return true;
  }
  if (rejectedImplausible > 0) {
    await logAttempt(db, {
      source: sourceId,
      instrumentId: instrument.id,
      ok: false,
      message:
        `${written} price points saved, ${rejectedImplausible} rejected ` +
        `as an implausible price jump (over ${MAX_PLAUSIBLE_RATIO}x)`,
    });
    return false;
  }
  await logAttempt(db, {
    source: sourceId,
    instrumentId: instrument.id,
    ok: true,
    message: `${written} price points`,
  });
  return true;
};

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

/**
 * Writes one instrument's fetched points and logs how it went. Returns whether
 * it counts as ok.
 *
 * A point the plausibility check refuses is reported as a failure, not folded
 * into a clean "ok" -- the fetch worked, the data was not trusted.
 */
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
    // Loud on purpose: an implausible price was just confirmed as a real
    // permanent change, which is worth a human's attention.
    const message =
      `${written} hintapistettä tallennettu, näistä ${reBaselined} ` +
      `UUDELLEENPERUSTETTU vahvistetun pysyvän muutoksen jälkeen` +
      (rejectedImplausible > 0 ? ` (${rejectedImplausible} yhä hylätty)` : "");
    console.warn(`Hintasarja uudelleenperustettu: ${sourceId} instrumentille ${instrument.id}`);
    await logAttempt(db, { source: sourceId, instrumentId: instrument.id, ok: true, message });
    return true;
  }
  if (rejectedImplausible > 0) {
    await logAttempt(db, {
      source: sourceId,
      instrumentId: instrument.id,
      ok: false,
      message:
        `${written} hintapistettä tallennettu, ${rejectedImplausible} hylätty ` +
        `epäuskottavana hintahyppynä (yli ${MAX_PLAUSIBLE_RATIO}x)`,
    });
    return false;
  }
  await logAttempt(db, {
    source: sourceId,
    instrumentId: instrument.id,
    ok: true,
    message: `${written} hintapistettä`,
  });
  return true;
};

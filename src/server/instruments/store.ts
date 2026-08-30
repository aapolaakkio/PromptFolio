import { eq } from "drizzle-orm";

import type { Currency } from "../../core/money.ts";
import type { getDb } from "../db/index.ts";
import { instruments } from "../db/schema.ts";
import { HttpError } from "../errors.ts";

type Db = ReturnType<typeof getDb>["db"];

/** What a caller may set on a new instrument, already validated. */
export type NewInstrument = {
  readonly isin?: string | undefined;
  readonly ticker: string | null;
  readonly name: string;
  readonly kind: "stock" | "etf" | "fund" | "cash";
  readonly currency: Currency;
  readonly priceSource: "yahoo" | "nordnet_fund" | "op_fund" | "manual";
  readonly sourceKey?: string | undefined;
};

/**
 * Instruments are shared reference data across the family instance -- every
 * household member's transactions can reference the same Nokia share -- so they
 * are readable and creatable by any signed-in user. Only ledger rows are scoped
 * to their owner.
 */
export const listInstruments = (db: Db) => db.select().from(instruments).all();

/**
 * Registers an instrument, refusing one that is already there.
 *
 * Matched on ISIN when there is one and on name when there is not, because a
 * manual holding (a delisted share, a temporary line from a corporate action)
 * has no ISIN any registry will give up -- and inventing one would corrupt the
 * identifier every broker's rows join on.
 */
export const addInstrument = (db: Db, body: NewInstrument) => {
  const isin = body.isin ?? null;
  if (isin !== null) {
    const existing = db.select().from(instruments).where(eq(instruments.isin, isin)).get();
    if (existing) throw new HttpError(409, `ISIN ${isin} on jo lisätty`);
  } else {
    const existing = db.select().from(instruments).where(eq(instruments.name, body.name)).get();
    if (existing) throw new HttpError(409, `Arvopaperi ${body.name} on jo lisätty`);
  }

  const sourceKey = body.sourceKey?.trim() || isin || body.name;
  return db
    .insert(instruments)
    .values({ ...body, isin, sourceKey })
    .returning()
    .get();
};

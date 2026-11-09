import { eq, inArray } from "drizzle-orm";

import type { Db } from "../db/index.ts";
import { instrumentLookups, instruments, pageRecipes } from "../db/schema.ts";
import type { AddedInstrument, Draft, DraftTxn } from "../import/map.ts";
import type { FetchImpl } from "../prices/types.ts";
import type { PageDeps } from "./find-page.ts";
import type { InstrumentLookup } from "./lookup.ts";
import {
  lookupKey,
  readStoredLookup,
  rememberedLookup,
  storeLookupUnlessFound,
} from "./lookup-cache.ts";
import { addInstrument } from "./store.ts";

type Unknown = Draft["unknownIsins"][number];

const lookUp = async (
  db: Db,
  entry: Unknown,
  fetchImpl: FetchImpl,
  quoteSpacingMs: number | undefined,
  page: { readonly deps: PageDeps; readonly referenceMinor: number | null } | null,
): Promise<InstrumentLookup | null> => {
  try {
    return await rememberedLookup(
      db,
      entry.isin,
      entry.name,
      entry.currency,
      fetchImpl,
      Date.now,
      quoteSpacingMs,
      page === null ? undefined : { ...page.deps, referenceMinor: page.referenceMinor },
    );
  } catch (cause) {
    console.error(`Lookup of instrument ${entry.isin ?? entry.name} failed`, cause);
    return null;
  }
};

const addable = (entry: Unknown, result: InstrumentLookup | null): AddedInstrument | null => {
  const isin = entry.isin ?? result?.isin ?? null;
  if (result === null || isin === null) return null;
  if (result.outcome !== "found" && result.outcome !== "pending") return null;
  const pending = result.outcome === "pending";
  return {
    isin,
    name: entry.name,
    kind: result.kind ?? "stock",
    currency: entry.currency,
    priceSource: pending ? null : result.priceSource,
    sourceKey: pending ? null : result.sourceKey,
    pending,
  };
};

/** The first buy's unit price: a found page's price must be plausible against it, so a hostile page cannot name any number. */
const firstBuyPrice = (txns: readonly DraftTxn[], entry: Unknown): number | null => {
  const key = lookupKey(entry.isin, entry.name);
  const buy = txns.find(
    (txn) =>
      txn.type === "BUY" &&
      txn.unitPrice !== null &&
      (entry.isin === null
        ? txn.isin === null && lookupKey(null, txn.instrumentName ?? "") === key
        : txn.isin === entry.isin),
  );
  return buy?.unitPrice ?? null;
};

const withDiscoveredIsin = (txn: DraftTxn, discovered: ReadonlyMap<string, string>): DraftTxn => {
  if (txn.isin !== null || txn.instrumentId !== null || txn.instrumentName === undefined) {
    return txn;
  }
  const isin = discovered.get(lookupKey(null, txn.instrumentName));
  return isin === undefined ? txn : { ...txn, isin };
};

/** Looks up each unresolved instrument once. Found or Yahoo-paused ones move to `added`; ones the owner must decide stay in `unknownIsins`. Writes only the lookup cache (instruments are created at commit), also under the ISIN a name lookup discovered. */
export const resolveUnknown = async (
  db: Db,
  draft: Draft,
  fetchImpl: FetchImpl,
  quoteSpacingMs?: number,
  page?: PageDeps,
): Promise<Draft> => {
  const distinct = new Map<string, Unknown>();
  for (const entry of draft.unknownIsins) {
    const key = lookupKey(entry.isin, entry.name);
    if (!distinct.has(key)) distinct.set(key, entry);
  }

  const added: AddedInstrument[] = [];
  const unknownIsins: Unknown[] = [];
  const discovered = new Map<string, string>();
  for (const entry of distinct.values()) {
    const lookup = await lookUp(
      db,
      entry,
      fetchImpl,
      quoteSpacingMs,
      page === undefined ? null : { deps: page, referenceMinor: firstBuyPrice(draft.txns, entry) },
    );
    const result = addable(entry, lookup);
    if (lookup === null || result === null) {
      unknownIsins.push(entry);
      continue;
    }
    if (entry.isin === null) {
      discovered.set(lookupKey(null, entry.name), result.isin);
      // Also under the ISIN, so the commit finds it without the browser sending the name back.
      await storeLookupUnlessFound(db, result.isin, lookup, new Date());
    }
    if (!added.some((a) => a.isin === result.isin)) added.push(result);
  }

  return {
    ...draft,
    txns: draft.txns.map((txn) => withDiscoveredIsin(txn, discovered)),
    unknownIsins,
    added,
  };
};

/** The lookup remembered for this ISIN, under it or under the broker's name; only one whose ISIN matches counts, so a row cannot borrow another's. */
const rememberedFor = async (
  db: Db,
  isin: string,
  names: readonly string[],
): Promise<InstrumentLookup | null> => {
  const keys = [isin, ...names.map((name) => lookupKey(null, name))];
  const rows = await db
    .select()
    .from(instrumentLookups)
    .where(inArray(instrumentLookups.key, keys))
    .all();
  for (const key of keys) {
    const row = rows.find((candidate) => candidate.key === key);
    const result = row === undefined ? null : readStoredLookup(row.result);
    if (result === null || result.isin !== isin) continue;
    if (result.outcome === "found" || result.outcome === "pending") return result;
  }
  return null;
};

const createFrom = async (
  db: Db,
  isin: string,
  lookup: InstrumentLookup,
  row: DraftTxn,
): Promise<number> => {
  const source =
    lookup.outcome === "found" && lookup.priceSource !== null && lookup.sourceKey !== null
      ? {
          priceSource: lookup.priceSource,
          sourceKey: lookup.sourceKey,
          lookupStatus: "ok" as const,
        }
      : { priceSource: "manual" as const, sourceKey: isin, lookupStatus: "pending" as const };
  const created = await addInstrument(db, {
    isin,
    ticker: null,
    name: row.instrumentName ?? lookup.name ?? isin,
    kind: lookup.kind ?? "stock",
    currency: lookup.listingCurrency ?? row.currency,
    ...source,
  });
  if (source.priceSource === "page" && lookup.pageRecipe !== null) {
    await db
      .insert(pageRecipes)
      .values({
        instrumentId: created.id,
        recipe: JSON.stringify(lookup.pageRecipe),
        askedAt: Date.now(),
      })
      .run();
  }
  return created.id;
};

const instrumentFor = async (
  db: Db,
  isin: string,
  rows: readonly [DraftTxn, ...DraftTxn[]],
): Promise<number | null> => {
  const existing = await db
    .select({ id: instruments.id })
    .from(instruments)
    .where(eq(instruments.isin, isin))
    .get();
  if (existing !== undefined) return existing.id;
  const names = rows.flatMap((row) =>
    row.instrumentName === undefined ? [] : [row.instrumentName],
  );
  const lookup = await rememberedFor(db, isin, names);
  return lookup === null ? null : await createFrom(db, isin, lookup, rows[0]);
};

/** What the commit must still refuse: unresolved draft entries not now linked, plus any row ISIN nothing resolved (so a draft sent back without its list is refused too). */
const stillUnknown = (
  draft: Draft,
  txns: readonly DraftTxn[],
  ids: ReadonlyMap<string, number>,
): Unknown[] => {
  const listed = draft.unknownIsins.filter((entry) => entry.isin === null || !ids.has(entry.isin));
  const missing = new Map<string, Unknown>();
  for (const txn of txns) {
    if (txn.isin === null || txn.instrumentId !== null || missing.has(txn.isin)) continue;
    if (listed.some((entry) => entry.isin === txn.isin)) continue;
    missing.set(txn.isin, {
      isin: txn.isin,
      name: txn.instrumentName ?? txn.isin,
      currency: txn.currency,
    });
  }
  return [...listed, ...missing.values()];
};

/**
 * At commit, creates the instruments the preview found and links their rows. What to create comes
 * from the rows and the server's remembered lookups, never from the browser-supplied draft `added`.
 * A registered ISIN is reused; one with nothing usable stays unresolved and is refused.
 */
export const createAdded = async (db: Db, draft: Draft): Promise<Draft> => {
  const byIsin = new Map<string, [DraftTxn, ...DraftTxn[]]>();
  for (const txn of draft.txns) {
    if (txn.isin === null || txn.instrumentId !== null) continue;
    byIsin.set(txn.isin, [...(byIsin.get(txn.isin) ?? []), txn]);
  }

  const ids = new Map<string, number>();
  for (const [isin, rows] of byIsin) {
    const id = await instrumentFor(db, isin, rows);
    if (id !== null) ids.set(isin, id);
  }

  const txns = draft.txns.map((txn) =>
    txn.isin === null || txn.instrumentId !== null
      ? txn
      : { ...txn, instrumentId: ids.get(txn.isin) ?? null },
  );
  return { ...draft, txns, unknownIsins: stillUnknown(draft, txns, ids) };
};

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

/** A lookup that throws is one the owner sees in the form, not a failed preview. */
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
    console.error(`Arvopaperin ${entry.isin ?? entry.name} haku epäonnistui`, cause);
    return null;
  }
};

/** What the review shows for a lookup the import can add by itself, or null. */
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

/**
 * The first buy's unit price for this instrument: what a found page's price
 * must be plausible against, so a hostile page cannot name any number.
 */
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

/** A row without an ISIN whose instrument's lookup discovered one. */
const withDiscoveredIsin = (txn: DraftTxn, discovered: ReadonlyMap<string, string>): DraftTxn => {
  if (txn.isin !== null || txn.instrumentId !== null || txn.instrumentName === undefined) {
    return txn;
  }
  const isin = discovered.get(lookupKey(null, txn.instrumentName));
  return isin === undefined ? txn : { ...txn, isin };
};

/**
 * Looks up each instrument the draft could not resolve, once per instrument.
 * One that was found, or that is waiting on a paused Yahoo, moves to `added`;
 * one the owner must decide on stays in `unknownIsins` for the form. Writes
 * nothing but the lookup cache: instruments are created at commit. A lookup
 * that discovered its ISIN from a name is remembered under that ISIN too.
 */
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
      // Also under the ISIN, so the commit finds it from the row alone: the
      // browser need not send the broker's name back.
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

/**
 * The lookup the preview remembered for this ISIN: under the ISIN itself, or
 * under the broker's name when the row had no ISIN and the lookup found it.
 * Only one whose ISIN is this one counts, so a row cannot borrow another's.
 */
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

/** Creates the instrument a remembered lookup describes, and returns its id. A page's recipe is stored with it. */
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

/** The id for one ISIN: an existing instrument's, a new one's, or null. */
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

/**
 * What the commit must still refuse: the draft's own unresolved entries, less
 * those now linked, plus any ISIN a row carries that nothing resolved -- so a
 * draft sent back without its list is refused all the same.
 */
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
 * At commit, creates the instruments the preview found and links their rows.
 *
 * What to create comes from the rows and the server's own remembered lookups,
 * never from the draft's `added`: the draft comes back from the browser, and a
 * price source or code in it is whatever the browser chose to send. An ISIN
 * already registered is reused. An ISIN with nothing usable remembered stays
 * unresolved, and the commit refuses it as before.
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

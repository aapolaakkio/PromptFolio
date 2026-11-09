import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import { z } from "zod";

import { reconcile, type SnapshotPosition } from "../../core/reconcile.ts";
import { EUR, formatQuantity, parseQuantity } from "../../core/money.ts";
import type { Txn } from "../../core/types.ts";
import { assertAccountOwned } from "../accounts.ts";
import { createClient, type ChatClient } from "../chat/runner.ts";
import { db } from "../db/index.ts";
import { imports, instruments, snapshotRows, snapshots, transactions } from "../db/schema.ts";
import { HttpError } from "../errors.ts";
import { loadPortfolio } from "../valuation.ts";
import { withModelTimeout } from "../instruments/find-page.ts";
import { explainGaps, type GapExplanations, type GapInput } from "./explain-gap.ts";
import { holdingsTotalCheck } from "./holdings-draft.ts";
import { decodeHoldingsFile, readHoldingsByRecipe } from "../import/recipe/holdings-recipe.ts";
import { extractPages } from "../import/pdf-read.ts";
import { MAX_PASTE_CHARS } from "../import/service.ts";
import { MAX_UPLOAD_BYTES } from "../import/upload.ts";

/** A fund name reduced to what two spellings share (brokers add suffixes like "-SIJOITUSRAHASTO A-OSUUDET"). Only to suggest a match; the user confirms every row. */
const normalise = (name: string): string =>
  name
    .toLowerCase()
    .replace(/-?(sijoitusrahasto|osuudet|rahasto)\b/g, " ")
    .replace(/[^a-z0-9åäö]+/g, " ")
    .trim();

const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in the form YYYY-MM-DD");

/**
 * Resolves one reconciliation row into a transaction. `costEur` is required when units arrive and refused when they leave:
 * a defaulted-to-zero cost would report the holding's whole value as gain. The UI may offer the statement's NAV, but a person chooses the stored figure.
 */
const Adjust = z.object({
  instrumentId: z.number().int().positive(),
  costEur: z.string().min(1).optional(),
});

/** A holdings statement as supplied: what the broker says was held on a date. Quantities are decimal strings, never JSON numbers. */
const PasteSnapshot = z.object({
  asOf: IsoDateSchema,
  text: z
    .string()
    .min(1, "Paste the table first")
    .max(MAX_PASTE_CHARS, "The pasted text is too large"),
});

const CreateSnapshot = z.object({
  accountId: z.number().int().positive(),
  asOf: IsoDateSchema,
  source: z.enum(["pdf", "vision", "manual"]),
  rows: z
    .array(
      z.object({
        instrumentId: z.number().int().positive(),
        quantity: z.string().min(1),
        nav: z.string().min(1).optional(),
        marketValue: z.string().min(1).optional(),
      }),
    )
    .min(1, "A snapshot without rows says nothing"),
  statedTotalEur: z.string().nullable().optional(),
});

/** Minor-unit integer from a decimal string, or a 400 naming the field. */
const toMinor = (text: string, label: string): number => {
  const parsed = Number(text.replace(",", ".").replace(/\s/g, ""));
  if (!Number.isFinite(parsed)) throw new HttpError(400, `${label} is not a valid number`);
  return Math.round(parsed * 100);
};

/** Snapshots are compared against the ledger, never merged into it: a misread statement can at worst show a difference the user dismisses. Nothing here writes a transaction. */
export const AccountQuery = z.object({ accountId: z.number().int().positive() });
export const SnapshotQuery = z.object({ snapshotId: z.number().int().positive() });
export const AdjustInput = z.intersection(SnapshotQuery, Adjust);

export const listSnapshots = async (userId: string, accountId: number) => {
  await assertAccountOwned(userId, accountId);
  return await db
    .select()
    .from(snapshots)
    .where(eq(snapshots.accountId, accountId))
    .orderBy(asc(snapshots.asOf))
    .all();
};

export const createSnapshot = async (userId: string, body: z.infer<typeof CreateSnapshot>) => {
  const input = CreateSnapshot.parse(body);
  await assertAccountOwned(userId, input.accountId);

  // Every row must name an existing instrument, or reconciliation would drop it and report a clean statement that never was.
  const known = new Set(
    (
      await db
        .select({ id: instruments.id })
        .from(instruments)
        .where(
          inArray(
            instruments.id,
            input.rows.map((row) => row.instrumentId),
          ),
        )
        .all()
    ).map((row) => row.id),
  );
  const unknown = input.rows.find((row) => !known.has(row.instrumentId));
  if (unknown !== undefined) {
    throw new HttpError(400, `Instrument ${unknown.instrumentId} does not exist`);
  }

  const check = holdingsTotalCheck(
    input.rows.map((row) => ({ marketValueEur: row.marketValue ?? "0" })),
    input.statedTotalEur ?? null,
  );
  if (check !== null && !check.ok) {
    throw new HttpError(
      400,
      `Row values do not match the statement total (difference ${check.differenceEur} €). Fix the rows before saving.`,
    );
  }

  // ponytail: two steps, not one transaction: the rows need the snapshot's generated id and D1 has no interactive transaction. A failure leaves a visible, re-importable snapshot with no rows.
  const snapshot = await db
    .insert(snapshots)
    .values({ accountId: input.accountId, asOf: input.asOf, source: input.source })
    .returning()
    .get();
  if (snapshot === undefined) throw new HttpError(500, "Creating the snapshot failed");

  if (input.rows.length > 0) {
    const rows = input.rows.map((row) =>
      db.insert(snapshotRows).values({
        snapshotId: snapshot.id,
        instrumentId: row.instrumentId,
        quantity: Number(parseQuantity(row.quantity).scaled),
        nav: row.nav === undefined ? 0 : toMinor(row.nav, "NAV"),
        marketValue: row.marketValue === undefined ? 0 : toMinor(row.marketValue, "Market value"),
      }),
    );
    // SAFETY: `db.batch` wants a non-empty tuple; the length check above establishes it.
    await db.batch(rows as [(typeof rows)[number], ...typeof rows]);
  }
  return snapshot;
};

const ownedSnapshot = async (userId: string, snapshotId: number) => {
  const snapshot = await db.select().from(snapshots).where(eq(snapshots.id, snapshotId)).get();
  if (!snapshot) throw new HttpError(404, "Snapshot not found");
  await assertAccountOwned(userId, snapshot.accountId);
  return snapshot;
};

const statedRows = async (snapshotId: number): Promise<SnapshotPosition[]> =>
  (await db.select().from(snapshotRows).where(eq(snapshotRows.snapshotId, snapshotId)).all()).map(
    (row) => ({ instrumentId: row.instrumentId, quantity: { scaled: BigInt(row.quantity) } }),
  );

export const reconcileSnapshot = async (userId: string, snapshotId: number) => {
  const snapshot = await ownedSnapshot(userId, snapshotId);
  const stated = await statedRows(snapshotId);

  // This account only: comparing against the whole portfolio would report every other holding as a difference.
  const { txns, instruments: known } = await loadPortfolio(db, userId);
  const ownTxns: Txn[] = txns.filter((t) => t.accountId === snapshot.accountId);
  const nameOf = new Map(known.map((i) => [i.id, i.name]));

  const rows = reconcile(ownTxns, stated, snapshot.asOf).map((row) => ({
    instrumentId: row.instrumentId,
    name: nameOf.get(row.instrumentId) ?? null,
    derived: formatQuantity(row.derived),
    snapshot: formatQuantity(row.snapshot),
    delta: formatQuantity(row.delta),
    withinTolerance: row.withinTolerance,
    presence: row.presence,
  }));

  return {
    snapshotId,
    accountId: snapshot.accountId,
    asOf: snapshot.asOf,
    source: snapshot.source,
    rows,
    differences: rows.filter((row) => !row.withinTolerance).length,
  };
};

const proposalFrom = async (
  userId: string,
  asOf: string,
  parsed: {
    holdings: ReadonlyArray<{ name: string; quantity: string; marketValueEur: string }>;
    problems: ReadonlyArray<{ line: number; message: string; raw: string }>;
  },
) => {
  const { instruments: known } = await loadPortfolio(db, userId);
  const byName = new Map(known.map((i) => [normalise(i.name), i.id]));
  return {
    asOf,
    rows: parsed.holdings.map((holding) => ({
      name: holding.name,
      quantity: holding.quantity,
      costEur: "",
      marketValueEur: holding.marketValueEur,
      instrumentId: byName.get(normalise(holding.name)) ?? null,
    })),
    problems: parsed.problems,
  };
};

/** Injected by tests, so a statement never reaches the real model. */
let readerClient: ChatClient | null = null;
export const _setReaderClient = (client: ChatClient | null): void => {
  readerClient = client;
};

/** The same ceiling every other upload has: the file is read whole, then sent in part to a model. */
const assertSize = (file: File): void => {
  if (file.size > MAX_UPLOAD_BYTES) throw new HttpError(413, "File is too large (max 5 MB)");
};

/** A recipe's complaint, as a 400 the owner can read. */
const asBadRequest = (cause: unknown, fallback: string): HttpError =>
  cause instanceof HttpError
    ? cause
    : new HttpError(400, cause instanceof Error ? cause.message : fallback);

/** A table or a one-value-per-line view, read by a recipe into a proposal. */
const proposeFromText = async (userId: string, text: string, asOf: string) => {
  const run = await readHoldingsByRecipe(text, userId, readerClient ?? createClient(), false);
  return proposalFrom(userId, asOf, { holdings: run.holdings, problems: run.problems });
};

/** Proposes a snapshot from a broker's holdings export via a recipe. Stores nothing: the user confirms through `createSnapshot`. */
export const proposeFromCsv = async (userId: string, form: FormData) => {
  const file = form.get("file");
  const asOf = IsoDateSchema.parse(form.get("asOf"));
  if (!(file instanceof File)) throw new HttpError(400, "File is missing");
  assertSize(file);
  try {
    const text = decodeHoldingsFile(new Uint8Array(await file.arrayBuffer()));
    return await proposeFromText(userId, text, asOf);
  } catch (cause) {
    throw asBadRequest(cause, "The file could not be read");
  }
};

/** Proposes a snapshot from a pasted holdings table (tab-separated, or one value per line). */
export const proposeFromPaste = async (userId: string, body: z.infer<typeof PasteSnapshot>) => {
  const input = PasteSnapshot.parse(body);
  try {
    return await proposeFromText(userId, input.text, input.asOf);
  } catch (cause) {
    throw asBadRequest(cause, "The pasted table could not be read");
  }
};

/** Proposes a snapshot from a holdings PDF with its date and printed total. The recipe is kept only when holdings add up to that total, which `createSnapshot` checks again. */
export const proposeFromPdf = async (userId: string, form: FormData) => {
  const file = form.get("file");
  if (!(file instanceof File)) throw new HttpError(400, "File is missing");
  assertSize(file);
  try {
    const pages = await extractPages(await file.arrayBuffer());
    const text = pages.map((page) => page.text).join("\n");
    const run = await readHoldingsByRecipe(text, userId, readerClient ?? createClient(), true);
    if (run.asOf === null) throw new Error("The statement date was not found");
    const proposal = await proposalFrom(userId, run.asOf, {
      holdings: run.holdings,
      problems: run.problems,
    });
    return {
      ...proposal,
      // A holdings PDF may print market value in a non-EUR currency; the row carries it for the review screen, while createSnapshot's total check still treats marketValueEur as EUR.
      rows: proposal.rows.map((row, index) => ({
        ...row,
        currency: run.holdings[index]?.currency ?? EUR,
      })),
      statedTotalEur: run.statedTotalEur,
      filename: file.name,
      source: "pdf" as const,
    };
  } catch (cause) {
    throw asBadRequest(cause, "The PDF could not be read");
  }
};

/** Removes a statement and its rows (cascade). An adjusting transaction it produced stays: it is a ledger entry the user chose. */
export const deleteSnapshot = async (userId: string, snapshotId: number) => {
  await ownedSnapshot(userId, snapshotId);
  await db.delete(snapshots).where(eq(snapshots.id, snapshotId)).run();
  return { deleted: snapshotId };
};

export const adjustSnapshotRow = async (
  userId: string,
  snapshotId: number,
  body: z.infer<typeof Adjust>,
) => {
  const input = Adjust.parse(body);
  const snapshot = await ownedSnapshot(userId, snapshotId);
  const stated = await statedRows(snapshotId);

  const { txns } = await loadPortfolio(db, userId);
  const own = txns.filter((t) => t.accountId === snapshot.accountId);
  const row = reconcile(own, stated, snapshot.asOf).find(
    (candidate) => candidate.instrumentId === input.instrumentId,
  );
  if (!row) throw new HttpError(404, "Row not found in this statement");

  // Identifiable forever and idempotent: the unique (accountId, externalId) index makes a repeat a conflict, not a duplicate.
  const externalId = `adjustment:${snapshotId}:${input.instrumentId}`;
  const existing = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(
      and(eq(transactions.accountId, snapshot.accountId), eq(transactions.externalId, externalId)),
    )
    .get();
  if (existing) throw new HttpError(409, "This row has already been corrected");

  if (row.withinTolerance) throw new HttpError(400, "Row already matches — nothing to correct");

  const arriving = row.delta.scaled > 0n;
  if (arriving && input.costEur === undefined) {
    throw new HttpError(400, "Cost basis is required when units are added");
  }
  if (!arriving && input.costEur !== undefined) {
    throw new HttpError(400, "Cost basis must not be given when units are removed");
  }

  const quantity = row.delta.scaled > 0n ? row.delta.scaled : -row.delta.scaled;
  const amount = arriving ? -Math.round(Number(input.costEur!.replace(",", ".")) * 100) : 0;
  if (!Number.isFinite(amount)) throw new HttpError(400, "Cost basis is not a valid number");

  return db
    .insert(transactions)
    .values({
      accountId: snapshot.accountId,
      instrumentId: input.instrumentId,
      type: arriving ? "TRANSFER_IN" : "TRANSFER_OUT",
      tradeDate: snapshot.asOf,
      quantity: Number(quantity),
      unitPrice: null,
      amount,
      fee: 0,
      tax: 0,
      currency: EUR,
      fxRateEur: 100_000_000,
      externalId,
      contentHash: externalId,
      note: `Reconciliation adjustment from statement ${snapshotId} (${snapshot.asOf})`,
    })
    .returning()
    .get();
};

const HISTORY_ROWS = 40;
const MAX_IMPORT_DATES = 50;

/** The ledger looks back a year from the statement, as far as a missing period or unbooked action is likely to reach. */
const yearBefore = (isoDate: string): string => {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCFullYear(date.getUTCFullYear() - 1);
  return date.toISOString().slice(0, 10);
};

const importDatesOf = async (userId: string, accountId: number): Promise<string[]> => {
  const ids = (
    await db
      .selectDistinct({ id: transactions.importId })
      .from(transactions)
      .where(and(eq(transactions.accountId, accountId), isNotNull(transactions.importId)))
      .all()
  ).flatMap((row) => (row.id === null ? [] : [row.id]));
  if (ids.length === 0) return [];
  const rows = await db
    .select({ createdAt: imports.createdAt })
    .from(imports)
    .where(and(eq(imports.userId, userId), inArray(imports.id, ids)))
    .all();
  return rows
    .map((row) => row.createdAt.toISOString().slice(0, 10))
    .sort()
    .slice(-MAX_IMPORT_DATES);
};

/** Asks a model why the differing rows differ. Read-only: a returned adjustment only prefills the owner's Adjust form, nothing is booked. */
export const explainSnapshot = async (
  userId: string,
  snapshotId: number,
  client?: ChatClient,
): Promise<GapExplanations> => {
  const snapshot = await ownedSnapshot(userId, snapshotId);
  const { txns, instruments: known } = await loadPortfolio(db, userId);
  const own = txns.filter((t) => t.accountId === snapshot.accountId);
  const byId = new Map(known.map((i) => [i.id, i]));
  const since = yearBefore(snapshot.asOf);

  const gaps: GapInput[] = reconcile(own, await statedRows(snapshotId), snapshot.asOf)
    .filter((row) => !row.withinTolerance)
    .map((row) => ({
      instrumentId: row.instrumentId,
      name: byId.get(row.instrumentId)?.name ?? `#${row.instrumentId}`,
      isin: byId.get(row.instrumentId)?.isin ?? null,
      ledger: formatQuantity(row.derived),
      statement: formatQuantity(row.snapshot),
      delta: formatQuantity(row.delta),
      txns: own
        .filter(
          (t) =>
            t.instrumentId === row.instrumentId &&
            t.tradeDate >= since &&
            t.tradeDate <= snapshot.asOf,
        )
        .slice(-HISTORY_ROWS)
        .map((t) => ({ date: t.tradeDate, type: t.type, quantity: formatQuantity(t.quantity) })),
    }));
  if (gaps.length === 0) return { failed: false, explanations: [], truncated: false };

  try {
    const model = withModelTimeout(client ?? createClient());
    return await explainGaps(
      model,
      snapshot.asOf,
      gaps,
      await importDatesOf(userId, snapshot.accountId),
    );
  } catch (cause) {
    // A model that cannot be configured is the same as one that is down.
    console.warn("Reconcile explanation failed:", cause instanceof Error ? cause.name : "unknown");
    return { failed: true, explanations: [], truncated: false };
  }
};

export { Adjust, CreateSnapshot, PasteSnapshot };

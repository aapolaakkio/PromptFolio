import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { reconcile, type SnapshotPosition } from "../../core/reconcile.ts";
import { EUR, formatQuantity, parseQuantity } from "../../core/money.ts";
import type { Txn } from "../../core/types.ts";
import { assertAccountOwned } from "../accounts.ts";
import { createClient, type ChatClient } from "../chat/runner.ts";
import { db } from "../db/index.ts";
import { instruments, snapshotRows, snapshots, transactions } from "../db/schema.ts";
import { HttpError } from "../errors.ts";
import { loadPortfolio } from "../valuation.ts";
import { holdingsTotalCheck } from "./holdings-draft.ts";
import { decodeHoldingsFile, readHoldingsByRecipe } from "../import/recipe/holdings-recipe.ts";
import { extractPages } from "../import/pdf-read.ts";

/**
 * A fund name reduced to what two spellings of the same fund share: brokers
 * print their own suffixes ("-SIJOITUSRAHASTO A-OSUUDET") that the ledger's own
 * name does not carry. Only used to *suggest* a match, never to commit one --
 * the user confirms every row.
 */
const normalise = (name: string): string =>
  name
    .toLowerCase()
    .replace(/-?(sijoitusrahasto|osuudet|rahasto)\b/g, " ")
    .replace(/[^a-z0-9åäö]+/g, " ")
    .trim();

const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Päivämäärän on oltava muotoa YYYY-MM-DD");

/**
 * Resolving one reconciliation row into a transaction the ledger did not have.
 *
 * `costEur` is required when units are arriving and refused when they are
 * leaving. An acquisition's cost basis cannot be guessed: defaulting it to zero
 * would report the holding's entire eventual value as gain, which is the exact
 * failure this project has already had to fix from three other causes. The
 * statement's own NAV can be offered as a default in the UI, but the figure
 * stored is one a person chose.
 */
const Adjust = z.object({
  instrumentId: z.number().int().positive(),
  costEur: z.string().min(1).optional(),
});

/**
 * A holdings statement as the user supplies it: what the broker says was held on
 * a date. Quantities arrive as decimal strings, never JSON numbers -- the wire
 * format rule the whole project follows, so a fractional fund unit cannot lose
 * precision on the way in.
 */
const PasteSnapshot = z.object({
  asOf: IsoDateSchema,
  text: z.string().min(1, "Liitä taulukko ensin"),
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
    .min(1, "Tilannevedos ilman rivejä ei kerro mitään"),
  statedTotalEur: z.string().nullable().optional(),
});

/** Minor-unit integer from a decimal string, or a 400 naming the field. */
const toMinor = (text: string, label: string): number => {
  const parsed = Number(text.replace(",", ".").replace(/\s/g, ""));
  if (!Number.isFinite(parsed)) throw new HttpError(400, `${label} ei ole kelvollinen luku`);
  return Math.round(parsed * 100);
};

/**
 * Snapshots are compared against the ledger, never merged into it (spec §5.2):
 * the worst a misread statement can do is show a difference the user dismisses.
 * Nothing here writes a transaction.
 */
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

  // Every row must name an instrument that exists, or the reconciliation would
  // silently drop it and report a clean statement that never was.
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
    throw new HttpError(400, `Arvopaperia ${unknown.instrumentId} ei ole olemassa`);
  }

  const check = holdingsTotalCheck(
    input.rows.map((row) => ({ marketValueEur: row.marketValue ?? "0" })),
    input.statedTotalEur ?? null,
  );
  if (check !== null && !check.ok) {
    throw new HttpError(
      400,
      `Rivien arvot eivät täsmää otteen kokonaisarvoon (ero ${check.differenceEur} €). Korjaa rivit ennen tallennusta.`,
    );
  }

  // ponytail: two steps, not one transaction. The rows need the snapshot's
  // generated id, which only exists once its insert has run, and D1 has no
  // interactive transaction to read it inside. The rows are still one batch,
  // so the failure left behind is a snapshot with no rows -- visible and
  // re-importable -- rather than a half-filled one.
  const snapshot = await db
    .insert(snapshots)
    .values({ accountId: input.accountId, asOf: input.asOf, source: input.source })
    .returning()
    .get();
  if (snapshot === undefined) throw new HttpError(500, "Tilannevedoksen luonti epäonnistui");

  if (input.rows.length > 0) {
    const rows = input.rows.map((row) =>
      db.insert(snapshotRows).values({
        snapshotId: snapshot.id,
        instrumentId: row.instrumentId,
        quantity: Number(parseQuantity(row.quantity).scaled),
        nav: row.nav === undefined ? 0 : toMinor(row.nav, "NAV"),
        marketValue: row.marketValue === undefined ? 0 : toMinor(row.marketValue, "Markkina-arvo"),
      }),
    );
    // SAFETY: `db.batch` is typed as a non-empty tuple; the length check above
    // is what establishes `rows` is non-empty here.
    await db.batch(rows as [(typeof rows)[number], ...typeof rows]);
  }
  return snapshot;
};

const ownedSnapshot = async (userId: string, snapshotId: number) => {
  const snapshot = await db.select().from(snapshots).where(eq(snapshots.id, snapshotId)).get();
  if (!snapshot) throw new HttpError(404, "Tilannevedosta ei löydy");
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

  // Only this account's transactions: a statement covers one account, and
  // comparing it against the whole portfolio would report every holding
  // elsewhere as a difference.
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

export const proposalFrom = async (
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

/**
 * Proposes a snapshot from a broker's holdings export, read by a recipe like
 * every other import. Stores nothing -- the user confirms through
 * `createSnapshot`.
 */
export const proposeFromCsv = async (userId: string, form: FormData) => {
  const file = form.get("file");
  const asOf = IsoDateSchema.parse(form.get("asOf"));
  if (!(file instanceof File)) throw new HttpError(400, "Tiedosto puuttuu");
  try {
    const text = decodeHoldingsFile(new Uint8Array(await file.arrayBuffer()));
    return await proposeFromText(userId, text, asOf);
  } catch (cause) {
    throw asBadRequest(cause, "Tiedostoa ei voitu lukea");
  }
};

/**
 * Proposes a snapshot from a broker's on-screen holdings table, pasted in: a
 * tab-separated table or one value per line, whichever the recipe describes.
 */
export const proposeFromPaste = async (userId: string, body: z.infer<typeof PasteSnapshot>) => {
  const input = PasteSnapshot.parse(body);
  try {
    return await proposeFromText(userId, input.text, input.asOf);
  } catch (cause) {
    throw asBadRequest(cause, "Liitettyä taulukkoa ei voitu lukea");
  }
};

/**
 * Proposes a snapshot from a holdings statement PDF. The statement's own date
 * and printed total come with it; the recipe is only kept when the holdings add
 * up to that total, and the owner edits and confirms through `createSnapshot`,
 * which checks the total again.
 */
export const proposeFromPdf = async (userId: string, form: FormData) => {
  const file = form.get("file");
  if (!(file instanceof File)) throw new HttpError(400, "Tiedosto puuttuu");
  try {
    const pages = await extractPages(await file.arrayBuffer());
    const text = pages.map((page) => page.text).join("\n");
    const run = await readHoldingsByRecipe(text, userId, readerClient ?? createClient(), true);
    if (run.asOf === null) throw new Error("Otteen päivää ei löytynyt");
    const proposal = await proposalFrom(userId, run.asOf, {
      holdings: run.holdings,
      problems: run.problems,
    });
    return {
      ...proposal,
      // A holdings PDF's market value may be printed in a currency other than
      // EUR; the row carries it along so the review screen can show it, while
      // the total check (createSnapshot's) still treats marketValueEur as EUR.
      rows: proposal.rows.map((row, index) => ({
        ...row,
        currency: run.holdings[index]?.currency ?? EUR,
      })),
      statedTotalEur: run.statedTotalEur,
      filename: file.name,
      source: "pdf" as const,
    };
  } catch (cause) {
    throw asBadRequest(cause, "PDF-tiedostoa ei voitu lukea");
  }
};

/**
 * Removes a statement. Its rows go with it through the schema's cascade; any
 * adjusting transaction it produced deliberately does not -- an adjustment is a
 * ledger entry the user chose to make, and tidying up must not retract it.
 */
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
  if (!row) throw new HttpError(404, "Riviä ei löydy tästä otteesta");

  // Identifiable forever, and idempotent: the unique (accountId, externalId)
  // index means adjusting the same row twice is a conflict, not a silent
  // duplicate.
  const externalId = `adjustment:${snapshotId}:${input.instrumentId}`;
  const existing = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(
      and(eq(transactions.accountId, snapshot.accountId), eq(transactions.externalId, externalId)),
    )
    .get();
  if (existing) throw new HttpError(409, "Tämä rivi on jo korjattu");

  if (row.withinTolerance) throw new HttpError(400, "Rivi täsmää jo — korjattavaa ei ole");

  const arriving = row.delta.scaled > 0n;
  if (arriving && input.costEur === undefined) {
    throw new HttpError(400, "Hankintameno vaaditaan, kun osuuksia lisätään");
  }
  if (!arriving && input.costEur !== undefined) {
    throw new HttpError(400, "Hankintamenoa ei anneta, kun osuuksia poistetaan");
  }

  const quantity = row.delta.scaled > 0n ? row.delta.scaled : -row.delta.scaled;
  const amount = arriving ? -Math.round(Number(input.costEur!.replace(",", ".")) * 100) : 0;
  if (!Number.isFinite(amount)) throw new HttpError(400, "Hankintameno ei ole kelvollinen luku");

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
      note: `Täsmäytyskorjaus otteesta ${snapshotId} (${snapshot.asOf})`,
    })
    .returning()
    .get();
};

export { Adjust, CreateSnapshot, PasteSnapshot };

import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { reconcile, type SnapshotPosition } from "../../core/reconcile";
import { EUR, formatQuantity, parseQuantity } from "../../core/money";
import type { Txn } from "../../core/types";
import { assertAccountOwned } from "./accounts";
import { requireUser } from "../auth-guard";
import { getDb } from "../db";
import { instruments, snapshotRows, snapshots, transactions } from "../db/schema";
import { HttpError, handle, json } from "../http";
import { loadPortfolio } from "../valuation";
import { parseOpHoldings } from "../import/op-pdf";

const { db } = getDb();

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
export const snapshotRoutes = {
  "/api/snapshots": {
    GET: handle(async (request) => {
      const { userId } = await requireUser(request);
      const accountId = z.coerce
        .number()
        .int()
        .positive()
        .parse(new URL(request.url).searchParams.get("accountId"));
      assertAccountOwned(userId, accountId);

      return json(
        db
          .select()
          .from(snapshots)
          .where(eq(snapshots.accountId, accountId))
          .orderBy(asc(snapshots.asOf))
          .all(),
      );
    }),

    POST: handle(async (request) => {
      const { userId } = await requireUser(request);
      const body = CreateSnapshot.parse(await request.json());
      assertAccountOwned(userId, body.accountId);

      // Every row must name an instrument that exists, or the reconciliation
      // would silently drop it and report a clean statement that never was.
      const known = new Set(
        db
          .select({ id: instruments.id })
          .from(instruments)
          .where(
            inArray(
              instruments.id,
              body.rows.map((row) => row.instrumentId),
            ),
          )
          .all()
          .map((row) => row.id),
      );
      const unknown = body.rows.find((row) => !known.has(row.instrumentId));
      if (unknown !== undefined) {
        throw new HttpError(400, `Arvopaperia ${unknown.instrumentId} ei ole olemassa`);
      }

      return json(
        db.transaction((tx) => {
          const snapshot = tx
            .insert(snapshots)
            .values({ accountId: body.accountId, asOf: body.asOf, source: body.source })
            .returning()
            .get();

          for (const row of body.rows) {
            tx.insert(snapshotRows)
              .values({
                snapshotId: snapshot.id,
                instrumentId: row.instrumentId,
                quantity: Number(parseQuantity(row.quantity).scaled),
                nav: row.nav === undefined ? 0 : toMinor(row.nav, "NAV"),
                marketValue:
                  row.marketValue === undefined ? 0 : toMinor(row.marketValue, "Markkina-arvo"),
              })
              .run();
          }
          return snapshot;
        }),
        201,
      );
    }),
  },

  "/api/snapshots/:id/reconcile": {
    GET: handle(async (request) => {
      const { userId } = await requireUser(request);
      const snapshotId = z.coerce
        .number()
        .int()
        .positive()
        .parse(new URL(request.url).pathname.split("/").at(-2));

      const snapshot = db.select().from(snapshots).where(eq(snapshots.id, snapshotId)).get();
      if (!snapshot) throw new HttpError(404, "Tilannevedosta ei löydy");
      assertAccountOwned(userId, snapshot.accountId);

      const stated: SnapshotPosition[] = db
        .select()
        .from(snapshotRows)
        .where(eq(snapshotRows.snapshotId, snapshotId))
        .all()
        .map((row) => ({
          instrumentId: row.instrumentId,
          quantity: { scaled: BigInt(row.quantity) },
        }));

      // Only this account's transactions: a statement covers one account, and
      // comparing it against the whole portfolio would report every holding
      // elsewhere as a difference.
      const { txns, instruments: known } = loadPortfolio(db, userId);
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

      return json({
        snapshotId,
        accountId: snapshot.accountId,
        asOf: snapshot.asOf,
        source: snapshot.source,
        rows,
        differences: rows.filter((row) => !row.withinTolerance).length,
      });
    }),
  },

  "/api/snapshots/pdf": {
    /**
     * Reads a broker's PDF statement and proposes the snapshot it describes,
     * without storing anything. The user confirms it through POST /api/snapshots
     * like any other statement.
     *
     * A preview rather than a direct write because a statement names its funds
     * the way the broker prints them, which is not how they are named in the
     * ledger -- one real statement says "OP-MAAILMA INDEKSI -SIJOITUSRAHASTO A"
     * for a holding registered as "OP-MAAILMA INDEKSI A". A name this parser
     * cannot match comes back with a null instrumentId for the user to resolve,
     * never matched to the closest guess.
     */
    POST: handle(async (request) => {
      const { userId } = await requireUser(request);
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof File)) throw new HttpError(400, "Tiedosto puuttuu");

      // A file this parser cannot read is the caller's problem, not a server
      // fault: it means the wrong PDF, or a scanned one with no text layer,
      // which the vision path (spec §5.2) exists for.
      let statement;
      try {
        statement = parseOpHoldings(new Uint8Array(await file.arrayBuffer()));
      } catch (cause) {
        throw new HttpError(400, cause instanceof Error ? cause.message : "PDF:ää ei voitu lukea");
      }
      const { instruments: known } = loadPortfolio(db, userId);
      const byName = new Map(known.map((i) => [normalise(i.name), i.id]));

      return json({
        asOf: statement.asOf,
        rows: statement.holdings.map((holding) => ({
          name: holding.name,
          quantity: holding.quantity,
          costEur: holding.costEur,
          marketValueEur: holding.marketValueEur,
          instrumentId: byName.get(normalise(holding.name)) ?? null,
        })),
      });
    }),
  },

  "/api/snapshots/:id": {
    /**
     * Removes a statement. Its rows go with it through the schema's cascade;
     * any adjusting transaction it produced deliberately does not.
     *
     * An adjustment is a ledger entry the user chose to make. Deleting the
     * statement it came from must not silently retract it -- that would change
     * holdings as a side effect of tidying up. The transaction stays, still
     * carrying the note naming a statement that no longer exists, which is
     * honest: it records what was decided and on what basis.
     */
    DELETE: handle(async (request) => {
      const { userId } = await requireUser(request);
      const snapshotId = z.coerce
        .number()
        .int()
        .positive()
        .parse(new URL(request.url).pathname.split("/").at(-1));

      const snapshot = db.select().from(snapshots).where(eq(snapshots.id, snapshotId)).get();
      if (!snapshot) throw new HttpError(404, "Tilannevedosta ei löydy");
      assertAccountOwned(userId, snapshot.accountId);

      db.delete(snapshots).where(eq(snapshots.id, snapshotId)).run();
      return json({ deleted: snapshotId });
    }),
  },

  "/api/snapshots/:id/adjust": {
    POST: handle(async (request) => {
      const { userId } = await requireUser(request);
      const snapshotId = z.coerce
        .number()
        .int()
        .positive()
        .parse(new URL(request.url).pathname.split("/").at(-2));
      const body = Adjust.parse(await request.json());

      const snapshot = db.select().from(snapshots).where(eq(snapshots.id, snapshotId)).get();
      if (!snapshot) throw new HttpError(404, "Tilannevedosta ei löydy");
      assertAccountOwned(userId, snapshot.accountId);

      const stated: SnapshotPosition[] = db
        .select()
        .from(snapshotRows)
        .where(eq(snapshotRows.snapshotId, snapshotId))
        .all()
        .map((row) => ({
          instrumentId: row.instrumentId,
          quantity: { scaled: BigInt(row.quantity) },
        }));

      const { txns } = loadPortfolio(db, userId);
      const own = txns.filter((t) => t.accountId === snapshot.accountId);
      const row = reconcile(own, stated, snapshot.asOf).find(
        (candidate) => candidate.instrumentId === body.instrumentId,
      );
      if (!row) throw new HttpError(404, "Riviä ei löydy tästä otteesta");
      // Identifiable forever, and idempotent: the unique (accountId, externalId)
      // index means adjusting the same row twice is a conflict, not a silent
      // duplicate. An adjustment is the user asserting units exist with no
      // broker record behind it, so it must never blend in with imported rows.
      const externalId = `adjustment:${snapshotId}:${body.instrumentId}`;
      const existing = db
        .select({ id: transactions.id })
        .from(transactions)
        .where(
          and(
            eq(transactions.accountId, snapshot.accountId),
            eq(transactions.externalId, externalId),
          ),
        )
        .get();
      if (existing) throw new HttpError(409, "Tämä rivi on jo korjattu");

      if (row.withinTolerance) {
        throw new HttpError(400, "Rivi täsmää jo — korjattavaa ei ole");
      }

      const arriving = row.delta.scaled > 0n;
      if (arriving && body.costEur === undefined) {
        throw new HttpError(400, "Hankintameno vaaditaan, kun osuuksia lisätään");
      }
      if (!arriving && body.costEur !== undefined) {
        throw new HttpError(400, "Hankintamenoa ei anneta, kun osuuksia poistetaan");
      }

      const quantity = row.delta.scaled > 0n ? row.delta.scaled : -row.delta.scaled;
      const amount = arriving ? -Math.round(Number(body.costEur!.replace(",", ".")) * 100) : 0;
      if (!Number.isFinite(amount))
        throw new HttpError(400, "Hankintameno ei ole kelvollinen luku");

      const inserted = db
        .insert(transactions)
        .values({
          accountId: snapshot.accountId,
          instrumentId: body.instrumentId,
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

      return json(inserted, 201);
    }),
  },
};

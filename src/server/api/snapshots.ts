import { asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { reconcile, type SnapshotPosition } from "../../core/reconcile";
import { formatQuantity, parseQuantity } from "../../core/money";
import type { Txn } from "../../core/types";
import { assertAccountOwned } from "./accounts";
import { requireUser } from "../auth-guard";
import { getDb } from "../db";
import { instruments, snapshotRows, snapshots } from "../db/schema";
import { HttpError, handle, json } from "../http";
import { loadPortfolio } from "../valuation";

const { db } = getDb();

const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Päivämäärän on oltava muotoa YYYY-MM-DD");

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
};

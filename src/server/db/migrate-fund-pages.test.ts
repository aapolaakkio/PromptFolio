import { eq } from "drizzle-orm";
import { expect, test } from "vitest";

import { readText } from "../files.ts";
import type { ChatClient } from "../chat/runner.ts";
import { refreshPage } from "../prices/page.ts";
import { instruments, pageRecipes, prices } from "./schema.ts";
import { testDb } from "./test-db.ts";

const NOW = Date.parse("2026-08-27T18:00:00Z");
const OP_URL =
  "https://www.op.fi/henkiloasiakkaat/saastot-ja-sijoitukset/rahastot/kaikki-rahastot/op-maailma-indeksi";
const NORDNET_URL = "https://www.nordnet.fi/rahastot/lista/nordnet-suomi-indeksi-eur-a401761d";

const migrationSql = async (): Promise<string[]> => {
  const dir = `${import.meta.dirname}/../../../drizzle`;
  const { readdir } = await import("node:fs/promises");
  const name = (await readdir(dir)).find((entry) => entry.endsWith("_fund-pages"));
  if (name === undefined) throw new Error("fund-pages migration missing");
  const sql = await readText(`${dir}/${name}/migration.sql`);
  return sql
    .replace(/^-- .*$/gm, "")
    .split("--> statement-breakpoint")
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter((part) => part.length > 0);
};

const seed = async (
  binding: Awaited<ReturnType<typeof testDb>>["binding"],
  source: string,
  key: string,
  isin: string,
) => {
  await binding
    .prepare(
      "INSERT INTO instruments (isin, name, kind, currency, price_source, source_key) " +
        "VALUES (?, 'Testirahasto', 'fund', 'EUR', ?, ?)",
    )
    .bind(isin, source, key)
    .run();
  const row = await binding
    .prepare("SELECT id FROM instruments WHERE isin = ?")
    .bind(isin)
    .first<{ id: number }>();
  if (row === null) throw new Error("seed failed");
  await binding
    .prepare(
      "INSERT INTO prices (instrument_id, date, close, currency, source, fetched_at) " +
        "VALUES (?, '2026-08-26', 1234, 'EUR', ?, 0)",
    )
    .bind(row.id, source)
    .run();
  return row.id;
};

const migrate = async (binding: Awaited<ReturnType<typeof testDb>>["binding"]) => {
  for (const statement of await migrationSql()) await binding.prepare(statement).run();
};

test("an op_fund row becomes a page with its full URL, and its prices stay", async () => {
  const { db, binding } = await testDb();
  const opId = await seed(binding, "op_fund", "op-maailma-indeksi", "FI0000000001");
  const nordnetId = await seed(
    binding,
    "nordnet_fund",
    "nordnet-suomi-indeksi-eur-a401761d",
    "SE0005993102",
  );

  await migrate(binding);

  const op = await db.select().from(instruments).where(eq(instruments.id, opId)).get();
  const nordnet = await db.select().from(instruments).where(eq(instruments.id, nordnetId)).get();
  expect([op?.priceSource, op?.sourceKey]).toEqual(["page", OP_URL]);
  expect([nordnet?.priceSource, nordnet?.sourceKey]).toEqual(["page", NORDNET_URL]);
  expect(await db.select().from(prices).where(eq(prices.instrumentId, opId)).all()).toHaveLength(1);
  expect(await db.select().from(pageRecipes).all()).toHaveLength(0);
});

test("a moved fund whose first recipe cannot be verified goes to attention and keeps its prices", async () => {
  const { db, binding } = await testDb();
  const id = await seed(binding, "op_fund", "op-maailma-indeksi", "FI0000000001");
  await migrate(binding);
  const moved = await db.select().from(instruments).where(eq(instruments.id, id)).get();
  if (moved === undefined) throw new Error("missing");
  const client: ChatClient = { run: async () => ({ text: "ei reseptiä", toolCalls: [] }) };

  const outcome = await refreshPage(db, moved, {
    fetchImpl: async () => new Response("<p>Ei NAV-tietoa</p>"),
    client,
    today: "2026-08-27",
    now: NOW,
  });

  const after = await db.select().from(instruments).where(eq(instruments.id, id)).get();
  expect(outcome).toBe("attention");
  expect(after?.lookupStatus).toBe("attention");
  expect(await db.select().from(prices).where(eq(prices.instrumentId, id)).all()).toHaveLength(1);
});

import { readdirSync } from "node:fs";

import { defineConfig } from "drizzle-kit";

/**
 * Studio only, against the local D1 that `wrangler dev` writes. Separate from
 * `drizzle.config.ts` so generation stays credential-free: this one has to name
 * a database, and the only one it may name is the throwaway on this machine.
 *
 * Never point this at the deployed database. Studio writes as readily as it
 * reads, and the deployed one holds real statements.
 *
 * Usage: pnpm db:studio
 */
const D1_DIR = ".wrangler/state/v3/d1/miniflare-D1DatabaseObject";

/**
 * Miniflare names the file after the binding, so the name changes with it.
 * Found rather than hardcoded, and `metadata.sqlite` is miniflare's own
 * bookkeeping rather than the database.
 */
const localD1 = (): string => {
  const files = readdirSync(D1_DIR).filter(
    (name) => name.endsWith(".sqlite") && name !== "metadata.sqlite",
  );
  const [only] = files;
  if (only === undefined || files.length > 1) {
    throw new Error(
      `Odotin yhtä paikallista D1-tiedostoa hakemistossa ${D1_DIR}, löysin ${files.length}. ` +
        "Aja ensin pnpm dev, joka luo sen.",
    );
  }
  return `${D1_DIR}/${only}`;
};

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/server/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: localD1() },
});

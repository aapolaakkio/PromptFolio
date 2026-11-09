import { readdirSync } from "node:fs";

import { defineConfig } from "drizzle-kit";

/** Studio against the local D1 only; never the deployed database (Studio writes, and it holds real statements). Usage: pnpm db:studio */
const D1_DIR = ".wrangler/state/v3/d1/miniflare-D1DatabaseObject";

/** Miniflare names the file after the binding, so find it; `metadata.sqlite` is bookkeeping. */
const localD1 = (): string => {
  const files = readdirSync(D1_DIR).filter(
    (name) => name.endsWith(".sqlite") && name !== "metadata.sqlite",
  );
  const [only] = files;
  if (only === undefined || files.length > 1) {
    throw new Error(
      `Expected one local D1 file in ${D1_DIR}, found ${files.length}. ` +
        "Run pnpm dev first, which creates it.",
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

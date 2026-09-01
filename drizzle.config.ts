import { defineConfig } from "drizzle-kit";

/**
 * Generation only. Applying is wrangler's job (`pnpm run db:migrate`), which
 * already knows the binding, tracks what has run and works against both the
 * local D1 and the deployed one -- so no account id or API token belongs here.
 */
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/server/db/schema.ts",
  out: "./drizzle",
});

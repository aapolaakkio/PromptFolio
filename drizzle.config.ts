import { defineConfig } from "drizzle-kit";

/** Generation only; applying is wrangler's job (`pnpm run db:migrate`), so no credentials belong here. */
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/server/db/schema.ts",
  out: "./drizzle",
});

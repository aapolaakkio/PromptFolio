import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/server/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url: Bun.env.DATABASE_PATH ?? './data/promptfolio.db' },
})

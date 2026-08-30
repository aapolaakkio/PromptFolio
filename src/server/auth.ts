import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { getDb } from "./db";
import { account, session, user, verification } from "./db/schema";
import { hashPassword, verifyPassword } from "./password";

const MIN_SECRET_LENGTH = 32;

/**
 * Validates `BETTER_AUTH_SECRET` from the given environment, refusing to
 * proceed without a real secret of at least 32 characters. A default or
 * missing secret in a self-hosted financial app is a silent authentication
 * bypass, so this throws rather than falling back to anything.
 *
 * Exported as a pure function (rather than inlined at module scope) so the
 * refusal-to-boot behaviour is directly unit-testable without every other
 * test file in the repo needing `BETTER_AUTH_SECRET` set just to import
 * this module.
 */
export const resolveAuthSecret = (env: Record<string, string | undefined>): string => {
  const secret = env.BETTER_AUTH_SECRET;
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`BETTER_AUTH_SECRET must be set to at least ${MIN_SECRET_LENGTH} characters`);
  }
  return secret;
};

/**
 * Sign-up is closed by default: this is a family instance, not a public
 * service. Set `ALLOW_SIGNUP=true` once to create each account, then unset
 * it. Exported for the same testability reason as `resolveAuthSecret`.
 */
export const resolveDisableSignUp = (env: Record<string, string | undefined>): boolean =>
  env.ALLOW_SIGNUP !== "true";

const { db } = getDb();

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "sqlite",
    // The shared `db` handle from getDb() is created without a `schema`
    // option (see src/server/db/index.ts), so drizzle-orm never populates
    // `db._.fullSchema`. Without passing `schema` here explicitly, the
    // adapter throws "Schema not found" the first time it resolves a model.
    schema: { user, session, account, verification },
  }),
  baseURL: process.env.BASE_URL ?? "http://localhost:3000",
  secret: resolveAuthSecret(process.env),
  emailAndPassword: {
    enabled: true,
    disableSignUp: resolveDisableSignUp(process.env),
    password: { hash: hashPassword, verify: verifyPassword },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
  },
});

import { env } from "cloudflare:workers";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";

import { db } from "./db/index.ts";
import { account, session, user, verification } from "./db/schema.ts";

const MIN_SECRET_LENGTH = 32;

/**
 * Validates `BETTER_AUTH_SECRET`, refusing to proceed without a real secret of
 * at least 32 characters. A default or missing secret in a self-hosted
 * financial app is a silent authentication bypass, so this throws rather than
 * falling back to anything.
 *
 * Exported as a pure function so the refusal is directly unit-testable.
 */
export const resolveAuthSecret = (vars: { BETTER_AUTH_SECRET?: string }): string => {
  const secret = vars.BETTER_AUTH_SECRET;
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`BETTER_AUTH_SECRET must be set to at least ${MIN_SECRET_LENGTH} characters`);
  }
  return secret;
};

/**
 * Sign-up is closed by default: this is a family instance, not a public
 * service. Set `ALLOW_SIGNUP=true` once to create each account, then unset it.
 */
export const resolveDisableSignUp = (vars: { ALLOW_SIGNUP?: string }): boolean =>
  vars.ALLOW_SIGNUP !== "true";

/**
 * Built on first use rather than at module scope: a Worker evaluates modules
 * during a request, and reading configuration at import time is what TanStack
 * Start warns against for edge runtimes.
 *
 * Password hashing is Better Auth's own (scrypt). The argon2 backend this
 * replaced was a native Rust binding, which workerd cannot load.
 */
const build = () =>
  betterAuth({
    database: drizzleAdapter(db, {
      provider: "sqlite",
      // The shared `db` handle is created without a `schema` option, so
      // drizzle-orm never populates `db._.fullSchema`. Without this the adapter
      // throws "Schema not found" the first time it resolves a model.
      schema: { user, session, account, verification },
    }),
    baseURL: env.BASE_URL,
    secret: resolveAuthSecret(env),
    emailAndPassword: {
      enabled: true,
      disableSignUp: resolveDisableSignUp(env),
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
    },
  });

let instance: ReturnType<typeof build> | undefined;

export const getAuth = (): ReturnType<typeof build> => {
  instance ??= build();
  return instance;
};

/**
 * Test-only: drops the memoised instance so the next `getAuth()` reads the
 * configuration again. The refusals above are read once and remembered, so a
 * test that changes a var has no other way to see the difference.
 */
export const _resetAuthForTests = (): void => {
  instance = undefined;
};

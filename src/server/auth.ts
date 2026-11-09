import { env } from "cloudflare:workers";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";

import { db } from "./db/index.ts";
import { account, session, user, verification } from "./db/schema.ts";

const MIN_SECRET_LENGTH = 32;

/** Validates `BETTER_AUTH_SECRET`: throws unless it is a real secret of at least 32 characters (a default or missing one is a silent auth bypass). Pure, so the refusal is unit-testable. */
export const resolveAuthSecret = (vars: { BETTER_AUTH_SECRET?: string }): string => {
  const secret = vars.BETTER_AUTH_SECRET;
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`BETTER_AUTH_SECRET must be set to at least ${MIN_SECRET_LENGTH} characters`);
  }
  return secret;
};

/** Sign-up is closed by default (a family instance): set `ALLOW_SIGNUP=true` once per account, then unset. */
export const resolveDisableSignUp = (vars: { ALLOW_SIGNUP?: string }): boolean =>
  vars.ALLOW_SIGNUP !== "true";

/** Built on first use: a Worker evaluates modules during a request and edge runtimes should not read config at import. Hashing is Better Auth's scrypt (the argon2 binding could not load in workerd). */
const build = () =>
  betterAuth({
    database: drizzleAdapter(db, {
      provider: "sqlite",
      // The shared `db` is created without a `schema` option, so without this the adapter throws "Schema not found".
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

/** Test-only: drops the memoised instance so the next `getAuth()` re-reads configuration. */
export const _resetAuthForTests = (): void => {
  instance = undefined;
};

import { z } from "zod";
import { getDb } from "../db";
import { account, user } from "../db/schema";
import { hashPassword } from "../password";
import { HttpError, handle, json } from "../http";

const { db } = getDb();

// Mirrors Better Auth's own emailAndPassword defaults (see
// ctx.context.password.config.{min,max}PasswordLength in
// node_modules/better-auth/dist/api/routes/sign-up.mjs) -- this route
// creates the user/account rows directly instead of going through Better
// Auth's sign-up handler (see the module comment below for why), so it
// re-states the same bounds rather than silently accepting a password
// Better Auth's own sign-in flow would consider malformed.
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;

const CreateFirstUser = z.object({
  name: z.string().min(1, "Nimi on pakollinen").max(100),
  email: z.string().email("Sähköpostiosoite on virheellinen"),
  password: z
    .string()
    .min(MIN_PASSWORD_LENGTH, `Salasanan tulee olla vähintään ${MIN_PASSWORD_LENGTH} merkkiä`)
    .max(MAX_PASSWORD_LENGTH),
});

/** The public shape returned by both `createFirstUser` and its
 * `insertCredentialUser` helper -- deliberately just enough to confirm
 * what was created, nothing that wasn't already supplied by the caller. */
type FirstUserSummary = { id: string; email: string; name: string };

/**
 * True once the instance has any user at all. Safe to call unauthenticated
 * -- it is the one thing a stranger may legitimately ask before signing
 * in -- and this is the only fact it exposes: no count, no email, no
 * name. `setupRoutes`'s GET handler returns exactly this boolean and
 * nothing else.
 */
export const hasAnyUser = (): boolean =>
  db.select({ id: user.id }).from(user).limit(1).get() != null;

/**
 * Creates the instance's very first user account, replacing the
 * `ALLOW_SIGNUP=true` + `curl` dance the README used to document. This
 * deliberately does NOT call Better Auth's `/sign-up/email` handler (or
 * its programmatic `auth.api.signUpEmail` twin) -- both read
 * `emailAndPassword.disableSignUp` from `auth.ts`'s config, which is
 * `true` unless `ALLOW_SIGNUP=true` is set, and stays that way for the
 * lifetime of the process (see `auth.ts`'s `resolveDisableSignUp`, read
 * once at module load). Reusing that handler here would mean first-run
 * account creation only worked when the owner ALSO set `ALLOW_SIGNUP`,
 * i.e. it wouldn't actually replace the manual env-var dance -- it would
 * just move it one step earlier. So this route writes the `user` and
 * `account` rows itself, in the exact shape Better Auth's own sign-up
 * handler writes them (verified directly against
 * node_modules/better-auth/dist/api/routes/sign-up.mjs and
 * .../core/src/db/schema/account.ts's `createLocalAccountIssuer`): a
 * `user` row plus an `account` row with `providerId: "credential"`,
 * `issuer: "local:credential"`, and `accountId` equal to the new user's
 * id. Hashing goes through this project's own `hashPassword`
 * (`Bun.password`, argon2id -- password.ts), the same function Better
 * Auth's own config points `emailAndPassword.password.hash` at, so a
 * normal `POST /api/auth/sign-in/email` afterwards verifies it exactly as
 * it would any other account. See setup.test.ts's child-process test,
 * which proves this end-to-end by creating an account here and then
 * signing in with it through the real `auth.handler`.
 *
 * --- Race safety, and what this does and does not guarantee ---
 *
 * Two requests can arrive "at the same time" whenever zero users exist.
 * `hashPassword` is genuinely asynchronous (argon2id hashing happens off
 * the main thread), so it is NOT safe to check `hasAnyUser()` before
 * hashing and trust that result by the time the insert runs -- a second
 * request's check could read the database in the gap while the first
 * request is still hashing. So the check happens again, synchronously,
 * immediately before the insert: `bun:sqlite` (via drizzle-orm's
 * bun-sqlite driver) is a synchronous API -- `.get()`/`.run()` return
 * immediately, not a Promise -- so the count-then-insert below is one
 * uninterrupted block of synchronous JavaScript with no `await` inside
 * it. Bun's single-threaded event loop can only switch to another
 * request's handler at an `await`/microtask boundary; it cannot pause
 * synchronous code partway through to run something else. So whichever of
 * two concurrent requests' synchronous blocks the engine happens to run
 * first completes in full (count reads 0, both rows are inserted) before
 * the other's synchronous block can even start -- and that second block
 * then reads count 1 and refuses. This is a real, checked guarantee (see
 * setup.test.ts's concurrent-request test), not a probabilistic one --
 * but it is a guarantee about THIS process, not about the deployment. It
 * holds because PromptFolio runs as exactly one `Bun.serve` process with
 * one SQLite connection (see index.ts, compose.yaml -- no clustering, no
 * multiple workers sharing the database file). It would NOT hold if this
 * server were ever run as more than one process against the same
 * database.
 *
 * What this is NOT a guarantee of: that the request which wins the race
 * is the owner's. There is no credential to check yet -- that is the
 * entire problem a first-run flow exists to solve -- so "first request
 * after zero users" and "the owner" are not provably the same thing. If
 * the instance is reachable on the network before the owner visits it,
 * anyone who gets there first can become its only account. The fix for
 * that is operational, not code: don't expose a fresh instance publicly
 * before completing this step, same as you would not leave any other
 * unconfigured admin panel open to the internet.
 */
export const createFirstUser = async (
  input: z.infer<typeof CreateFirstUser>,
): Promise<FirstUserSummary> => {
  const passwordHash = await hashPassword(input.password);

  // Synchronous from here on -- see the guarantee explained above. No
  // `await`, no async call, until this function returns.
  if (hasAnyUser()) throw new HttpError(403, "Tili on jo luotu");
  return insertCredentialUser(input, passwordHash);
};

/**
 * Writes the `user` + `account` row pair for a new email/password account,
 * in the exact shape described in `createFirstUser`'s comment above. Split
 * out on its own so its correctness -- does the resulting row pair
 * actually authenticate through Better Auth's real, unmodified sign-in
 * flow? -- is directly testable (setup.test.ts calls this and then signs
 * in with the result) without needing an empty database first, unlike
 * `createFirstUser` itself, whose whole point is refusing to run this
 * once a user already exists.
 *
 * Deliberately NOT exported: it carries no guard of its own, so the only
 * caller allowed to reach it is `createFirstUser`, immediately after that
 * guard passes, as one synchronous block. setup.test.ts reaches it through
 * a same-file re-export for exactly that reason -- see this file's test
 * for the full explanation.
 */
const insertCredentialUser = (
  input: z.infer<typeof CreateFirstUser>,
  passwordHash: string,
): FirstUserSummary => {
  const email = input.email.toLowerCase();
  const now = new Date();
  const userId = crypto.randomUUID();

  db.insert(user)
    .values({
      id: userId,
      name: input.name,
      email,
      emailVerified: false,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(account)
    .values({
      id: crypto.randomUUID(),
      userId,
      accountId: userId,
      providerId: "credential",
      issuer: "local:credential",
      password: passwordHash,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  return { id: userId, email, name: input.name };
};

// Test-only re-export -- see insertCredentialUser's own comment for why it
// is not part of the module's real public surface otherwise.
export const _internal = { insertCredentialUser };

export const setupRoutes = {
  "/api/setup": {
    GET: handle(async () => json({ hasUsers: hasAnyUser() })),
    POST: handle(async (request) => {
      const body = CreateFirstUser.parse(await request.json());
      const created = await createFirstUser(body);
      return json(created, 201);
    }),
  },
};

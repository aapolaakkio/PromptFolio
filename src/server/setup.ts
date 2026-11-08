import { sql } from "drizzle-orm";
import { z } from "zod";
import { getAuth } from "./auth.ts";
import { db } from "./db/index.ts";
import { account, user } from "./db/schema.ts";
import { HttpError } from "./errors.ts";

// Mirrors Better Auth's own emailAndPassword defaults (see
// ctx.context.password.config.{min,max}PasswordLength in
// node_modules/better-auth/dist/api/routes/sign-up.mjs) -- this route
// creates the user/account rows directly instead of going through Better
// Auth's sign-up handler (see the module comment below for why), so it
// re-states the same bounds rather than silently accepting a password
// Better Auth's own sign-in flow would consider malformed.
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;

/**
 * What the first-run form may send. Exported because the server function's
 * validator is this schema, and the tests assert against it directly rather
 * than through a 400 that no longer exists.
 */
export const CreateFirstUser = z.object({
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
 * name. The getSetupState server function returns exactly this boolean and
 * nothing else.
 */
export const hasAnyUser = async (): Promise<boolean> =>
  (await db.select({ id: user.id }).from(user).limit(1).get()) != null;

/**
 * Creates the instance's first account, replacing an ALLOW_SIGNUP-and-curl dance.
 *
 * Deliberately not Better Auth's own sign-up handler: that reads the same
 * disable-signup config, so reusing it would move the manual env-var step one
 * place earlier rather than remove it. The user and account rows are written here
 * in exactly the shape that handler writes them, hashed by the same function its
 * config points at, so an ordinary sign-in afterwards verifies them normally.
 *
 * Race safety is the database's job now, not the driver's. The old note relied
 * on a synchronous driver making count-then-insert one uninterrupted block;
 * D1 is asynchronous and a Worker runs many isolates, so that argument is gone.
 * `insertCredentialUser` gets the guarantee from SQL instead -- see its comment
 * -- which also holds across isolates, as the old one never did.
 *
 * What it still does not guarantee is that the request winning the race is the
 * owner's: there is no credential to check yet. Do not expose a fresh instance
 * publicly before completing this step.
 */
export const createFirstUser = async (
  input: z.infer<typeof CreateFirstUser>,
): Promise<FirstUserSummary> => {
  // Better Auth's own hasher, so an ordinary sign-in afterwards verifies these
  // rows normally -- the same reason this file re-states its length bounds.
  const passwordHash = await getAuth().$context.then((context) =>
    context.password.hash(input.password),
  );

  return await insertCredentialUser(input, passwordHash);
};

/**
 * The user and account row pair for a new email/password account. Split out so a
 * test can prove the pair really authenticates, without needing an empty database.
 */
const insertCredentialUser = async (
  input: z.infer<typeof CreateFirstUser>,
  passwordHash: string,
): Promise<FirstUserSummary> => {
  const email = input.email.toLowerCase();
  const now = new Date();
  const userId = crypto.randomUUID();

  // Two statements as one batch, which D1 runs as a single transaction, and
  // between them they are the whole "exactly one owner" guarantee:
  //
  //  - the user row inserts only `WHERE NOT EXISTS (SELECT 1 FROM user)`, so a
  //    second caller writes nothing;
  //  - the account row then references that user id, and D1 enforces the
  //    foreign key, so the second caller's batch fails and rolls back.
  //
  // The check is the database's, not a read this code did earlier and hoped
  // was still true -- which is what makes it hold across isolates.
  const at = now.getTime();
  try {
    await db.batch([
      db.run(sql`
        INSERT INTO ${user} (id, name, email, email_verified, created_at, updated_at)
        SELECT ${userId}, ${input.name}, ${email}, 0, ${at}, ${at}
        WHERE NOT EXISTS (SELECT 1 FROM ${user})
      `),
      db.insert(account).values({
        id: crypto.randomUUID(),
        userId,
        accountId: userId,
        providerId: "credential",
        password: passwordHash,
        createdAt: now,
        updatedAt: now,
      }),
    ]);
  } catch {
    // The only way the pair can fail is the guard above rejecting a second
    // owner; anything else would already have failed validation.
    throw new HttpError(403, "Tili on jo luotu");
  }

  return { id: userId, email, name: input.name };
};

// Test-only re-export -- see insertCredentialUser's own comment for why it
// is not part of the module's real public surface otherwise.
export const _internal = { insertCredentialUser };

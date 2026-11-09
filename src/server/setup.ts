import { sql } from "drizzle-orm";
import { z } from "zod";
import { getAuth } from "./auth.ts";
import { db } from "./db/index.ts";
import { account, user } from "./db/schema.ts";
import { HttpError } from "./errors.ts";

// Mirrors Better Auth's emailAndPassword password length bounds: this route writes the rows directly, so it re-states them rather than accept a password Better Auth's sign-in would consider malformed.
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;

/** What the first-run form may send; the server function's validator, so tests assert against it directly. */
export const CreateFirstUser = z.object({
  name: z.string().min(1, "Name is required").max(100),
  email: z.email("Email address is invalid"),
  password: z
    .string()
    .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
    .max(MAX_PASSWORD_LENGTH),
});

/** What `createFirstUser` and `insertCredentialUser` return: enough to confirm what was created. */
type FirstUserSummary = { id: string; email: string; name: string };

/** True once any user exists. Safe unauthenticated, and exposes only this boolean (no count, email or name). */
export const hasAnyUser = async (): Promise<boolean> =>
  (await db.select({ id: user.id }).from(user).limit(1).get()) != null;

/**
 * Creates the instance's first account. Not Better Auth's own sign-up handler (it reads the disable-signup config):
 * rows are written in its shape with its hasher, so an ordinary sign-in verifies them.
 * Race safety is SQL's (see `insertCredentialUser`) and holds across isolates, but does not make the winner the owner:
 * do not expose a fresh instance publicly before this step.
 */
export const createFirstUser = async (
  input: z.infer<typeof CreateFirstUser>,
): Promise<FirstUserSummary> => {
  // Better Auth's own hasher, so an ordinary sign-in verifies these rows.
  const passwordHash = await getAuth().$context.then((context) =>
    context.password.hash(input.password),
  );

  return await insertCredentialUser(input, passwordHash);
};

/** The user and account row pair for a new email/password account; split out so a test can prove it authenticates without an empty database. */
const insertCredentialUser = async (
  input: z.infer<typeof CreateFirstUser>,
  passwordHash: string,
): Promise<FirstUserSummary> => {
  const email = input.email.toLowerCase();
  const now = new Date();
  const userId = crypto.randomUUID();

  // One batch (a single D1 transaction) is the whole "exactly one owner" guarantee:
  //  - the user row inserts only `WHERE NOT EXISTS (SELECT 1 FROM user)`, so a second caller writes nothing;
  //  - the account row references that user id and D1 enforces the foreign key, so the second batch fails and rolls back.
  // The check is the database's, not an earlier read, which is why it holds across isolates.
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
    // The pair can only fail by the guard rejecting a second owner; anything else fails validation first.
    throw new HttpError(403, "An account has already been created");
  }

  return { id: userId, email, name: input.name };
};

// Test-only re-export (see insertCredentialUser).
export const _internal = { insertCredentialUser };

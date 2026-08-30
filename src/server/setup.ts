import { z } from "zod";
import { getDb } from "./db/index.ts";
import { account, user } from "./db/schema.ts";
import { hashPassword } from "./password.ts";
import { HttpError } from "./errors.ts";

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
export const hasAnyUser = (): boolean =>
  db.select({ id: user.id }).from(user).limit(1).get() != null;

/**
 * Creates the instance's first account, replacing an ALLOW_SIGNUP-and-curl dance.
 *
 * Deliberately not Better Auth's own sign-up handler: that reads the same
 * disable-signup config, so reusing it would move the manual env-var step one
 * place earlier rather than remove it. The user and account rows are written here
 * in exactly the shape that handler writes them, hashed by the same function its
 * config points at, so an ordinary sign-in afterwards verifies them normally.
 *
 * Race safety: hashing is asynchronous, so a check before it cannot be trusted by
 * the time the insert runs. The check happens again immediately before the
 * insert, and the driver is synchronous, so count-then-insert is one uninterrupted
 * block -- the second concurrent request reads a count of one and refuses. That
 * holds for this process, which is the whole deployment; it would not hold across
 * several processes against one database.
 *
 * What it does not guarantee is that the request winning the race is the owner's:
 * there is no credential to check yet. Do not expose a fresh instance publicly
 * before completing this step.
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
 * The user and account row pair for a new email/password account. Split out so a
 * test can prove the pair really authenticates, without needing an empty database.
 *
 * Not exported: it carries no guard, so its only caller is the one above,
 * immediately after that guard passes, in the same synchronous block.
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

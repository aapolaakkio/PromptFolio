import { hash, verify } from "@node-rs/argon2";

/**
 * Password hashing backend for Better Auth.
 *
 * The parameters match what `Bun.password` was called with, and they have to:
 * argon2id writes them into the hash string, so every password stored before
 * this change is verified with the settings it was made under. Nobody is
 * locked out by the move off Bun's own hashing -- proven by a test, not by reading.
 */
// Argon2id is this library's default, and naming it explicitly is not
// available: `Algorithm` is an ambient const enum, which `verbatimModuleSyntax`
// forbids importing as a value. The variant still ends up in the hash string,
// so a wrong default would fail the pinned-hash test rather than pass quietly.
const OPTIONS = { memoryCost: 65536, timeCost: 3 } as const;

export const hashPassword = (password: string): Promise<string> => hash(password, OPTIONS);

export const verifyPassword = async (data: {
  password: string;
  hash: string;
}): Promise<boolean> => {
  try {
    return await verify(data.hash, data.password);
  } catch {
    // A stored hash that isn't a well-formed argon2id string (corrupted data, a
    // hand-edited row, a future migration mistake) makes verify throw instead
    // of returning false. This is an authentication boundary: fail closed with
    // `false`, the same outcome as a wrong password, rather than let the throw
    // propagate through Better Auth's sign-in flow uncaught.
    return false;
  }
};

/**
 * Password hashing backend for Better Auth, using Bun's built-in
 * `Bun.password` (argon2id) instead of a native argon2 dependency.
 */
const OPTIONS = { algorithm: "argon2id", memoryCost: 65536, timeCost: 3 } as const;

export const hashPassword = (password: string): Promise<string> =>
  Bun.password.hash(password, OPTIONS);

export const verifyPassword = async (data: {
  password: string;
  hash: string;
}): Promise<boolean> => {
  try {
    return await Bun.password.verify(data.password, data.hash);
  } catch {
    // A stored hash that isn't a well-formed argon2id string (corrupted
    // data, a hand-edited row, a future migration mistake) makes
    // Bun.password.verify throw instead of returning false. This is an
    // authentication boundary: fail closed with `false`, the same outcome
    // as a wrong password, rather than let the throw propagate through
    // Better Auth's sign-in flow uncaught.
    return false;
  }
};

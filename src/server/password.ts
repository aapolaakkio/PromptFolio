/**
 * Password hashing backend for Better Auth, using Bun's built-in
 * `Bun.password` (argon2id) instead of a native argon2 dependency.
 */
const OPTIONS = { algorithm: "argon2id", memoryCost: 65536, timeCost: 3 } as const;

export const hashPassword = (password: string): Promise<string> =>
  Bun.password.hash(password, OPTIONS);

export const verifyPassword = (data: { password: string; hash: string }): Promise<boolean> =>
  Bun.password.verify(data.password, data.hash);

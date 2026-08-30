import { describe, expect, test } from "vitest";

import { hashPassword, verifyPassword } from "./password.ts";

// The migration off Bun replaced `Bun.password` with @node-rs/argon2. Every
// password already stored was hashed by the old one, so the only thing that
// matters here is that the new code still opens the old locks.

/**
 * A real hash of "correct horse battery staple", produced by `Bun.password`
 * with the settings this app used. Pinned rather than generated, because a
 * hash made by the current code proves only that it agrees with itself.
 */
const HASHED_BY_BUN =
  "$argon2id$v=19$m=65536,t=3,p=1$mmlXdatEVRv/d5No4LSYKoweH1Be1tkt0HKz3kq9wPg$yQkFAMR+RX6nzt/O+lzbuh5txk6VUFk4Avl4YftBE+o";

describe("verifyPassword", () => {
  test("accepts a password against a hash Bun wrote", async () => {
    expect(
      await verifyPassword({ password: "correct horse battery staple", hash: HASHED_BY_BUN }),
    ).toBe(true);
  });

  test("rejects the wrong password against that same hash", async () => {
    expect(await verifyPassword({ password: "not it", hash: HASHED_BY_BUN })).toBe(false);
  });

  test("fails closed on a hash that is not a hash", async () => {
    // An authentication boundary: corrupted or hand-edited rows must read as a
    // wrong password, never as a throw escaping into the sign-in flow.
    expect(await verifyPassword({ password: "anything", hash: "not-a-hash" })).toBe(false);
    expect(await verifyPassword({ password: "anything", hash: "" })).toBe(false);
  });

  test("round-trips a password it hashed itself", async () => {
    const hash = await hashPassword("uusi salasana");

    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword({ password: "uusi salasana", hash })).toBe(true);
    expect(await verifyPassword({ password: "uusi salasan", hash })).toBe(false);
  });
});

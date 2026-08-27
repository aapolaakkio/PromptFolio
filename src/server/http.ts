import { ZodError } from "zod";
import { HttpError } from "./errors";

/**
 * Re-exported so route modules can `import { HttpError } from "./http"`
 * alongside `handle`/`json` without a second import line. This module must
 * stay free of any dependency on auth.ts (directly or transitively via
 * auth-guard.ts) — auth.ts opens a database connection and throws at
 * import time when BETTER_AUTH_SECRET is missing, and http.ts is meant to
 * be importable on its own. See accounts.test.ts's
 * "importing http.ts alone..." test, which proves this in a real child
 * process.
 */
export { HttpError };

export const json = <T>(data: T, status = 200): Response => Response.json(data, { status });

/**
 * Wraps a route handler so every error it can throw becomes a well-formed
 * JSON response instead of an unhandled rejection:
 *  - `HttpError` maps to its own status and message (both are safe to show
 *    the caller — every throw site chose that message deliberately).
 *  - `ZodError` (thrown by `Schema.parse(...)` on untrusted request bodies)
 *    maps to 400 with per-field detail.
 *  - anything else is logged in full on the server and reported to the
 *    client as a generic, detail-free 500. This is a security boundary:
 *    an unexpected error's message can contain SQL, file paths, or other
 *    internal detail that must never reach the client.
 */
export const handle =
  (fn: (request: Request) => Promise<Response>) =>
  async (request: Request): Promise<Response> => {
    try {
      return await fn(request);
    } catch (cause) {
      if (cause instanceof HttpError) return json({ error: cause.message }, cause.status);
      if (cause instanceof ZodError) {
        return json(
          {
            error: "Virheellinen pyyntö",
            fields: cause.issues.map((issue) => ({
              path: issue.path.join("."),
              message: issue.message,
            })),
          },
          400,
        );
      }
      console.error("Unhandled request error", cause);
      return json({ error: "Palvelinvirhe" }, 500);
    }
  };

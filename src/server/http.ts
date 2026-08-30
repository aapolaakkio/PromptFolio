import { ZodError } from "zod";
import { HttpError } from "./errors.ts";

/**
 * Re-exported so a caller needs one import line. This module must stay free of
 * any dependency on auth.ts, which opens a database and throws at import time
 * without a secret -- proved by a test in a real child process.
 */
export { HttpError };

export const json = <T>(data: T, status = 200): Response => Response.json(data, { status });

/**
 * Turns anything a handler throws into a well-formed JSON response: an HttpError
 * into its own status and message, a ZodError into a 400 with field detail, and
 * anything else into a detail-free 500, logged in full server-side.
 *
 * That last one is a security boundary: an unexpected error's message can carry
 * SQL or file paths that must never reach a client.
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

import { ZodError } from "zod";
import { HttpError } from "./errors.ts";

/** Re-exported for one import line. Must not depend on auth.ts (it opens a database and throws without a secret): proved by a child-process test. */
export { HttpError };

export const json = <T>(data: T, status = 200): Response => Response.json(data, { status });

/** Turns anything a handler throws into JSON: an HttpError into its status, a ZodError into a 400 with field detail, anything else into a detail-free 500 logged server-side (a message can carry SQL or paths). */
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
            error: "Invalid request",
            fields: cause.issues.map((issue) => ({
              path: issue.path.join("."),
              message: issue.message,
            })),
          },
          400,
        );
      }
      console.error("Unhandled request error", cause);
      return json({ error: "Server error" }, 500);
    }
  };

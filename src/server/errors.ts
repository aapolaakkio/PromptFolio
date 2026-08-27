/**
 * HTTP error thrown by server-side guards and route handlers. Lives in its
 * own module (rather than alongside `requireUser` in auth-guard.ts) so that
 * pure HTTP helpers can depend on it without transitively importing auth.ts,
 * which opens a database connection and throws at import time when
 * `BETTER_AUTH_SECRET` is missing.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

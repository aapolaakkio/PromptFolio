/** HTTP error thrown by guards and handlers. Its own module so pure HTTP helpers can use it without importing auth.ts (which opens a database and throws without `BETTER_AUTH_SECRET`). */
export class HttpError extends Error {
  // Assigned in the body, not a parameter property: Node cannot strip that syntax and this runs under plain Node in test child processes.
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "HttpError";
  }
}

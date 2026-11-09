/** The message of a thrown value, or `fallback` when it is not an Error. */
export const errorMessage = (cause: unknown, fallback: string): string =>
  cause instanceof Error ? cause.message : fallback;

import { z } from "zod";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Lets tests inject a stub instead of the real global `fetch` (which
 * `src/server/test-network-guard.ts` replaces with one that throws for any
 * un-stubbed call). Defaults to the real `fetch` for production callers.
 * Deliberately just the call signature, not `typeof fetch` -- the full
 * `Fetch` type also requires a static `preconnect` method that a plain
 * stub function has no reason to implement (see test-network-guard.ts's
 * own comment for the same constraint on the production side). The real
 * global `fetch` still satisfies this narrower signature structurally.
 */
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Matches http.ts's `json({ error: ... }, status)` shape for every server error. */
const ErrorBody = z.object({ error: z.string() });

/**
 * Reads a `Response` body as JSON and, on a non-2xx status, throws
 * `ApiError` with the server's own Finnish message. A malformed or
 * unparsable body falls back to a generic message rather than throwing a
 * raw parse error -- the caller always sees either the real payload or an
 * `ApiError`, never a `SyntaxError`.
 */
const unwrap = async (response: Response) => {
  const body: unknown = await response.json().catch(() => ({ error: "Vastausta ei voitu lukea" }));
  if (!response.ok) {
    const parsed = ErrorBody.safeParse(body);
    const message = parsed.success ? parsed.data.error : `Virhe ${response.status}`;
    throw new ApiError(response.status, message);
  }
  return body;
};

export const apiGet = async <T>(path: string, fetchImpl: FetchLike = fetch): Promise<T> => {
  const response = await fetchImpl(path, { credentials: "include" });
  const body = await unwrap(response);
  // SAFETY: `T` is the response shape documented at each call site (the
  // matching API route's JSON contract, e.g. GET /api/holdings). No route
  // yet has a shared Zod schema on the client side; this cast is the
  // boundary where trust in that documented contract begins.
  return body as T;
};

export const apiPost = async <T, B>(
  path: string,
  body: B,
  fetchImpl: FetchLike = fetch,
): Promise<T> => {
  const response = await fetchImpl(path, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = await unwrap(response);
  // SAFETY: see apiGet -- same call-site response contract.
  return parsed as T;
};

export const apiUpload = async <T>(
  path: string,
  form: FormData,
  fetchImpl: FetchLike = fetch,
): Promise<T> => {
  const response = await fetchImpl(path, { method: "POST", credentials: "include", body: form });
  const parsed = await unwrap(response);
  // SAFETY: see apiGet -- same call-site response contract.
  return parsed as T;
};

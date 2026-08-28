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

/**
 * `schema` is OPTIONAL on all three functions below, not because casting
 * is an accepted alternative going forward -- spec §9.2 requires
 * validation at every boundary, and every NEW call site should always
 * pass one, turning a server response-shape change into a loud
 * `ZodError` instead of silently wrong UI. It stays optional because
 * dashboard.tsx and holdings.tsx (Tasks 18/19) were already written and
 * committed against the no-schema, `as T`-cast form of this API by the
 * time this was tightened, and holdings.tsx was mid-edit by a concurrent
 * task when this was fixed -- making `schema` mandatory would have broken
 * their typecheck out from under them. dashboard.tsx has since been
 * migrated to pass real schemas (see its own top comment); holdings.tsx
 * is the one tracked exception left on the cast fallback.
 */
export const apiGet = async <T>(
  path: string,
  schema?: z.ZodType<T>,
  fetchImpl: FetchLike = fetch,
): Promise<T> => {
  const response = await fetchImpl(path, { credentials: "include" });
  const body = await unwrap(response);
  if (schema) return schema.parse(body);
  // SAFETY: no schema was supplied at this call site; `T` is the response
  // shape documented there instead (see this function's own doc comment
  // for why that's still possible here).
  return body as T;
};

/**
 * Deletes a resource. No body either way: every DELETE this app makes answers
 * with a small acknowledgement the caller does not read, so there is nothing to
 * parse and no schema to demand.
 */
export const apiDelete = async (path: string, fetchImpl: FetchLike = fetch): Promise<void> => {
  const response = await fetchImpl(path, { method: "DELETE", credentials: "include" });
  await unwrap(response);
};

export const apiPost = async <T, B>(
  path: string,
  body: B,
  schema?: z.ZodType<T>,
  fetchImpl: FetchLike = fetch,
): Promise<T> => {
  const response = await fetchImpl(path, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = await unwrap(response);
  if (schema) return schema.parse(parsed);
  // SAFETY: see apiGet's doc comment -- same call-site response contract.
  return parsed as T;
};

export const apiUpload = async <T>(
  path: string,
  form: FormData,
  schema?: z.ZodType<T>,
  fetchImpl: FetchLike = fetch,
): Promise<T> => {
  const response = await fetchImpl(path, { method: "POST", credentials: "include", body: form });
  const parsed = await unwrap(response);
  if (schema) return schema.parse(parsed);
  // SAFETY: see apiGet's doc comment -- same call-site response contract.
  return parsed as T;
};

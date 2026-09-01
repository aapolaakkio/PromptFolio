import { redirect } from "@tanstack/react-router";
import { createMiddleware } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

import { getAuth } from "../../server/auth.ts";
import { HttpError } from "../../server/errors.ts";

/**
 * The session, resolved once, for every server function that touches the
 * ledger.
 *
 * Middleware rather than a first line repeated in 40 handlers, because the
 * failure mode of the repeated line is silent: forget it in one function and
 * that function answers for whoever asks. Here a function either declares this
 * middleware and receives a `userId`, or has no `userId` to pass to anything --
 * the type system asks the question the reviewer would have to.
 *
 * The id is never a parameter. A model, a stale tab or a crafted request can
 * put anything in an argument; the cookie is what the server itself resolved.
 *
 * A missing session redirects rather than throwing a 401. Two reasons: it is
 * what a person wants when their session expires mid-session -- the login page,
 * not an error toast -- and the app's own HttpError does not survive the RPC
 * boundary, where seroval could not serialise it and turned a 401 into a 500.
 */
export const authed = createMiddleware({ type: "function" }).server(async ({ next }) => {
  const session = await getAuth().api.getSession({ headers: getRequest().headers });
  if (!session?.user?.id) throw redirect({ to: "/login" });
  return next({ context: { userId: session.user.id } });
});

/**
 * Runs a route-shaped body and turns its HttpError into a plain one.
 *
 * The status code is what an HTTP client needed; a caller of a function needs
 * the sentence. And HttpError itself cannot make the trip: seroval refuses to
 * serialise it and the caller gets a 500 with no message at all, which is worse
 * than either. The message survives, which is the part a person reads.
 */
export const readable = async <T>(run: () => T | Promise<T>): Promise<T> => {
  try {
    return await run();
  } catch (cause) {
    if (cause instanceof HttpError) throw new Error(cause.message);
    throw cause;
  }
};

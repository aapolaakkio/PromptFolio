import { redirect } from "@tanstack/react-router";
import { createMiddleware } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

import { getAuth } from "../../server/auth.ts";
import { withOwnerName } from "../../server/chat/owner-name.ts";
import { HttpError } from "../../server/errors.ts";

/**
 * Resolves the session once for every ledger server function: a function either declares this middleware and gets a `userId`, or has none.
 * The id is never a parameter. The owner's name rides along so model clients made inside can hide it. A missing session redirects (not a 401): HttpError does not survive the RPC boundary (seroval turns it into a 500).
 */
export const authed = createMiddleware({ type: "function" }).server(async ({ next }) => {
  const session = await getAuth().api.getSession({ headers: getRequest().headers });
  if (!session?.user?.id) throw redirect({ to: "/login" });
  const { id, name } = session.user;
  return withOwnerName(name, () => next({ context: { userId: id } }));
});

/** Runs a route-shaped body and turns its HttpError into a plain Error, since seroval cannot serialise HttpError; the message survives. */
export const readable = async <T>(run: () => T | Promise<T>): Promise<T> => {
  try {
    return await run();
  } catch (cause) {
    if (cause instanceof HttpError) throw new Error(cause.message);
    throw cause;
  }
};

import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

import { getAuth } from "../../server/auth.ts";

/**
 * Who is signed in, decided on the server from the request's own cookie.
 *
 * In its own module because Start splits a server function's handler -- and
 * everything the handler imports -- out of the client bundle. `auth.ts` opens a
 * database connection at import time; it must never be reachable from a route
 * file the browser also loads.
 *
 * Returns the little the interface needs rather than Better Auth's session
 * object: a name to greet, an id to key on. The token stays on the server.
 */
export const currentSession = createServerFn().handler(async () => {
  const session = await getAuth().api.getSession({ headers: getRequest().headers });
  if (!session) return null;
  return { userId: session.user.id, name: session.user.name };
});

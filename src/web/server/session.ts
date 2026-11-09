import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

import { getAuth } from "../../server/auth.ts";

/** Who is signed in, from the request cookie. Own module because Start splits server handlers out of the client bundle and `auth.ts` opens a DB at import. Returns only a name and id; the token stays server-side. */
export const currentSession = createServerFn().handler(async () => {
  const session = await getAuth().api.getSession({ headers: getRequest().headers });
  if (!session) return null;
  return { userId: session.user.id, name: session.user.name };
});

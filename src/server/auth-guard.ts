import { getAuth } from "./auth.ts";
import { HttpError } from "./errors.ts";

/**
 * Resolves the authenticated user from a request's session cookie.
 * Every route handler must call this first and scope its queries by the
 * returned `userId` — ownership of any resource named in the request body
 * or path is never inferred from the request alone.
 */
export const requireUser = async (request: Request): Promise<{ userId: string }> => {
  const session = await getAuth().api.getSession({ headers: request.headers });
  if (!session?.user?.id) throw new HttpError(401, "Kirjautuminen vaaditaan");
  return { userId: session.user.id };
};

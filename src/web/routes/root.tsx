import { signOut } from "../lib/auth-client.ts";
import { errorMessage } from "../lib/errors.ts";
import { SessionGate } from "./session-gate.tsx";

/** Ends the session, then leaves: the route guard only runs on navigation, so nothing else would move the page. */
export const signOutAndLeave = async (
  endSession: () => Promise<void>,
  go: (path: string) => void,
): Promise<void> => {
  await endSession();
  go("/login");
};

/** Session gate for the authenticated layout route; `/login` is a sibling, not a descendant, or its blank `return null` would hide the sign-in page. */
export const AuthenticatedLayout = () => (
  // `_authenticated.tsx` beforeLoad has already guaranteed a session on the server.
  <SessionGate
    isPending={false}
    hasSession
    onSignOut={() =>
      void signOutAndLeave(
        async () => {
          const { error } = await signOut();
          if (error) throw new Error(error.message ?? "Sign-out failed");
        },
        // A full load, not a client navigation: it also drops the cached figures from memory.
        (path) => window.location.assign(path),
      ).catch((cause: unknown) => window.alert(errorMessage(cause, "Sign-out failed")))
    }
  />
);

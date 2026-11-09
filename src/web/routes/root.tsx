import { signOut } from "../lib/auth-client.ts";
import { SessionGate } from "./session-gate.tsx";

/** Session gate for the authenticated layout route; `/login` is a sibling, not a descendant, or its blank `return null` would hide the sign-in page. */
export const AuthenticatedLayout = () => (
  // `_authenticated.tsx` beforeLoad has already guaranteed a session on the server.
  <SessionGate isPending={false} hasSession onSignOut={() => void signOut()} />
);

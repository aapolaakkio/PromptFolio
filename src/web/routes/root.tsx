import { signOut } from "../lib/auth-client.ts";
import { SessionGate } from "./session-gate.tsx";

/**
 * Session gate for the authenticated part of the app (dashboard, holdings,
 * imports) -- NOT the whole route tree. `router.ts` mounts this as a
 * pathless layout route ("authenticated") whose children are exactly the
 * protected pages; `/login` is a SIBLING of that layout, not a descendant
 * of it.
 *
 * That split matters: `SessionGate`'s early `return null` when there is
 * no session is intentional (see its own comment in session-gate.tsx),
 * but earlier drafts of this route tree had `/login` nested UNDER this
 * same gate, so a logged-out visit to `/login` itself also hit that
 * `return null` before `<Outlet/>` (which is what renders LoginPage) ever
 * mounted. The URL changed to `/login` via the redirect below, but
 * nothing ever rendered there -- a permanent blank page with no way to
 * sign in. Keeping `/login` outside this layout's subtree in the route
 * tree (see `route-tree.ts`) is what fixes that; this component does not
 * need to know its own route is gated.
 *
 * This file itself stays thin and untested on purpose: `useSession()` is
 * a real network-backed hook (better-auth's react client), and this
 * project has no way to stub the browser `fetch` it eventually calls
 * without touching vitest.config.ts's test network guard. All of the
 * actually-testable logic -- what to render for each of the three session
 * states -- lives in `./session-gate.tsx`'s `SessionGate`, exercised by
 * `session-gate.test.ts` with `react-dom/server`'s `renderToStaticMarkup`.
 */
export const AuthenticatedLayout = () => (
  // No session hook and no redirect effect: `_authenticated.tsx`'s beforeLoad
  // has already decided, on the server, that there is a session -- reaching
  // this component at all means one exists. What was a loading state, a
  // redirect effect and a flash of empty chrome is now a rendered page.
  <SessionGate isPending={false} hasSession onSignOut={() => void signOut()} />
);

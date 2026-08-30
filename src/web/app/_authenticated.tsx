import { createFileRoute, redirect } from "@tanstack/react-router";

import { AuthenticatedLayout } from "../routes/root.tsx";
import { currentSession } from "../server/session.ts";

/**
 * Everything behind the login, as route-tree.ts's pathless "authenticated"
 * route was. A leading underscore is Start's spelling of a layout that wraps
 * its children without adding a path segment.
 *
 * The gate runs in `beforeLoad`, which means on the server for the first
 * request: a signed-out visitor is redirected before any HTML is produced, and
 * a signed-in one gets the real page rendered rather than a "Ladataan…" that
 * only becomes the dashboard after hydration. It runs again in the browser on
 * every client-side navigation, so the check is not a one-off at boot.
 */
export const Route = createFileRoute("/_authenticated")({
  beforeLoad: async () => {
    const session = await currentSession();
    if (!session) throw redirect({ to: "/login" });
    return { session };
  },
  component: AuthenticatedLayout,
});

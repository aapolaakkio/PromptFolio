import { createFileRoute, redirect } from "@tanstack/react-router";

import { AuthenticatedLayout } from "../routes/root.tsx";
import { currentSession } from "../server/session.ts";

/** Everything behind the login (a pathless layout). The gate runs in `beforeLoad`: on the server for the first request (redirect before any HTML) and again on every client navigation. */
export const Route = createFileRoute("/_authenticated")({
  beforeLoad: async () => {
    const session = await currentSession();
    if (!session) throw redirect({ to: "/login" });
    return { session };
  },
  component: AuthenticatedLayout,
});

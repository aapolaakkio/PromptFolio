import { createFileRoute } from "@tanstack/react-router";

import { AuthenticatedLayout } from "../routes/root.tsx";

/**
 * Everything behind the login, as `route-tree.ts`'s pathless "authenticated"
 * route was. A leading underscore is how Start spells a layout that wraps its
 * children without adding a path segment.
 */
export const Route = createFileRoute("/_authenticated")({ component: AuthenticatedLayout });

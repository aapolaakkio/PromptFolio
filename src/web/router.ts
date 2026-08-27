import { createRouter } from "@tanstack/react-router";
import { buildRouteTree } from "./route-tree";
import { DashboardPage } from "./routes/dashboard";
import { HoldingsPage } from "./routes/holdings";
import { ImportsPage } from "./routes/imports";
import { LoginPage } from "./routes/login";
import { AuthenticatedLayout } from "./routes/root";

// Wires the real page components into the tree structure built by
// route-tree.ts. This module is intentionally never imported by a test
// (route-tree.test.ts tests the structure directly, with stub
// components) -- importing it would pull every page component, and the
// chart library, into the coverage report. See route-tree.ts's top
// comment for the full reasoning and the bug this split was born from.
const { routeTree } = buildRouteTree({
  authenticated: AuthenticatedLayout,
  dashboard: DashboardPage,
  holdings: HoldingsPage,
  imports: ImportsPage,
  login: LoginPage,
});

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

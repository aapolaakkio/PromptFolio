import { createRouter } from "@tanstack/react-router";
import { buildRouteTree } from "./route-tree.ts";
import { CashPage } from "./routes/cash.tsx";
import { ChatPage } from "./routes/chat.tsx";
import { DashboardPage } from "./routes/dashboard.tsx";
import { HoldingsPage } from "./routes/holdings.tsx";
import { ImportsPage } from "./routes/imports.tsx";
import { LoginPage } from "./routes/login.tsx";
import { ReconcilePage } from "./routes/reconcile.tsx";
import { SpendingPage } from "./routes/spending.tsx";
import { RebalancePage } from "./routes/rebalance.tsx";
import { TaxPage } from "./routes/tax.tsx";
import { AuthenticatedLayout } from "./routes/root.tsx";

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
  reconcile: ReconcilePage,
  chat: ChatPage,
  cash: CashPage,
  spending: SpendingPage,
  tax: TaxPage,
  rebalance: RebalancePage,
  login: LoginPage,
});

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

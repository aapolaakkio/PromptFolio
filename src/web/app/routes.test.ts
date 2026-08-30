import { describe, expect, test } from "vitest";

import { CashPage } from "../routes/cash.tsx";
import { ChatPage } from "../routes/chat.tsx";
import { DashboardPage } from "../routes/dashboard.tsx";
import { HoldingsPage } from "../routes/holdings.tsx";
import { ImportsPage } from "../routes/imports.tsx";
import { LoginPage } from "../routes/login.tsx";
import { RebalancePage } from "../routes/rebalance.tsx";
import { ReconcilePage } from "../routes/reconcile.tsx";
import { AuthenticatedLayout } from "../routes/root.tsx";
import { SpendingPage } from "../routes/spending.tsx";
import { TaxPage } from "../routes/tax.tsx";

// The successor to route-tree.test.ts, which tested the same thing when the
// tree was built in code: that every screen is reachable and points at the
// component it claims to. A route file is one line of wiring, and a wrong line
// here is a page that silently renders the wrong screen.
const routes = {
  "/_authenticated": [() => import("./_authenticated.tsx"), AuthenticatedLayout],
  "/_authenticated/": [() => import("./_authenticated/index.tsx"), DashboardPage],
  "/_authenticated/holdings": [() => import("./_authenticated/holdings.tsx"), HoldingsPage],
  "/_authenticated/imports": [() => import("./_authenticated/imports.tsx"), ImportsPage],
  "/_authenticated/reconcile": [() => import("./_authenticated/reconcile.tsx"), ReconcilePage],
  "/_authenticated/chat": [() => import("./_authenticated/chat.tsx"), ChatPage],
  "/_authenticated/cash": [() => import("./_authenticated/cash.tsx"), CashPage],
  "/_authenticated/spending": [() => import("./_authenticated/spending.tsx"), SpendingPage],
  "/_authenticated/tax": [() => import("./_authenticated/tax.tsx"), TaxPage],
  "/_authenticated/rebalance": [() => import("./_authenticated/rebalance.tsx"), RebalancePage],
  "/login": [() => import("./login.tsx"), LoginPage],
} as const;

describe("route files", () => {
  for (const [path, [load, component]] of Object.entries(routes)) {
    test(`${path} renders its own screen`, async () => {
      const module = await load();

      expect(module.Route.options.component).toBe(component);
    });
  }

  test("login sits outside the authenticated layout", () => {
    // The one route a signed-out visitor must reach. If it ever moves under
    // /_authenticated, signing in becomes impossible without being signed in.
    expect(Object.keys(routes)).toContain("/login");
    expect(Object.keys(routes).filter((path) => path.startsWith("/_authenticated"))).not.toContain(
      "/login",
    );
  });
});

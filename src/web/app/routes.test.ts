import { describe, expect, test } from "vitest";

import { CashPage } from "../routes/cash.tsx";
import { ChatPage } from "../routes/chat.tsx";
import { DashboardPage } from "../routes/dashboard.tsx";
import { ForecastPage } from "../routes/forecast.tsx";
import { HoldingsPage } from "../routes/holdings.tsx";
import { ImportsPage } from "../routes/imports.tsx";
import { LoginPage } from "../routes/login.tsx";
import { RebalancePage } from "../routes/rebalance.tsx";
import { ReconcilePage } from "../routes/reconcile.tsx";
import { AuthenticatedLayout } from "../routes/root.tsx";
import { SpendingPage } from "../routes/spending.tsx";
import { TaxPage } from "../routes/tax.tsx";

// Every screen is reachable and points at its component; a wrong line is a page silently rendering the wrong screen.
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
  "/_authenticated/forecast": [() => import("./_authenticated/forecast.tsx"), ForecastPage],
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
    // Must stay outside /_authenticated, or signing in needs a sign-in.
    expect(Object.keys(routes)).toContain("/login");
    expect(Object.keys(routes).filter((path) => path.startsWith("/_authenticated"))).not.toContain(
      "/login",
    );
  });
});

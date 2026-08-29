import { createRootRoute, createRoute } from "@tanstack/react-router";
import type { RouteComponent } from "@tanstack/react-router";

/**
 * The page components the route tree wires up, injected rather than
 * imported directly by this module. Kept deliberately generic
 * (TanStack Router's own `RouteComponent` type) -- this module's only job is the NESTING
 * structure, not which concrete component ends up on which route.
 *
 * That separation is what makes `route-tree.test.ts` possible at all:
 * this file has zero imports of `./routes/dashboard`, `./routes/holdings`,
 * `./routes/imports`, `./routes/login` or `./routes/root`, so a test can
 * exercise the real tree-building logic with trivial stub components
 * instead of the real ones -- which would otherwise pull those page
 * modules (and the chart library dashboard.tsx depends on) into the
 * test's transitive import graph and trip `bunfig.toml`'s per-file 0.8
 * coverage gate on files this project deliberately keeps untested (no DOM
 * harness -- see `routes/holdings-sort.ts`'s comment for the same
 * convention applied to `holdings.tsx`).
 */
export type RouteComponents = {
  readonly authenticated: RouteComponent;
  readonly dashboard: RouteComponent;
  readonly holdings: RouteComponent;
  readonly imports: RouteComponent;
  readonly reconcile: RouteComponent;
  readonly chat: RouteComponent;
  readonly cash: RouteComponent;
  readonly spending: RouteComponent;
  readonly tax: RouteComponent;
  readonly rebalance: RouteComponent;
  readonly login: RouteComponent;
};

/**
 * Builds the app's route tree.
 *
 * The true root has no session opinion of its own -- it defaults to
 * rendering an `<Outlet/>`. The session gate lives one level down, on the
 * pathless "authenticated" layout route, so `/login` can be a SIBLING of
 * that gate rather than a descendant of it.
 *
 * This structure fixes a real Critical bug: an earlier version nested
 * `/login` UNDER the session-gated layout. That layout's component
 * returns `null` when there is no session (deliberately, so a signed-out
 * visitor never sees a flash of the authenticated chrome), but `/login`
 * being a descendant of it meant that same `return null` ran on every
 * visit to `/login` too -- before `<Outlet/>` (which is what renders the
 * login page) ever got a chance to mount. The URL became `/login` via the
 * redirect, but nothing ever rendered there: a permanent blank page with
 * no way to sign in, on an app whose entire population is signed out on
 * first visit. `route-tree.test.ts` asserts the parent-child structure
 * below directly, which is what would have caught this before it shipped.
 */
export const buildRouteTree = (components: RouteComponents) => {
  const rootRoute = createRootRoute();

  const authenticatedRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: "authenticated",
    component: components.authenticated,
  });

  const dashboardRoute = createRoute({
    getParentRoute: () => authenticatedRoute,
    path: "/",
    component: components.dashboard,
  });
  const holdingsRoute = createRoute({
    getParentRoute: () => authenticatedRoute,
    path: "/holdings",
    component: components.holdings,
  });
  const importsRoute = createRoute({
    getParentRoute: () => authenticatedRoute,
    path: "/imports",
    component: components.imports,
  });
  const reconcileRoute = createRoute({
    getParentRoute: () => authenticatedRoute,
    path: "/reconcile",
    component: components.reconcile,
  });
  const chatRoute = createRoute({
    getParentRoute: () => authenticatedRoute,
    path: "/chat",
    component: components.chat,
  });
  const cashRoute = createRoute({
    getParentRoute: () => authenticatedRoute,
    path: "/cash",
    component: components.cash,
  });
  const spendingRoute = createRoute({
    getParentRoute: () => authenticatedRoute,
    path: "/spending",
    component: components.spending,
  });
  const taxRoute = createRoute({
    getParentRoute: () => authenticatedRoute,
    path: "/tax",
    component: components.tax,
  });
  const rebalanceRoute = createRoute({
    getParentRoute: () => authenticatedRoute,
    path: "/rebalance",
    component: components.rebalance,
  });
  const loginRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/login",
    component: components.login,
  });

  const routeTree = rootRoute.addChildren([
    authenticatedRoute.addChildren([
      dashboardRoute,
      holdingsRoute,
      importsRoute,
      reconcileRoute,
      chatRoute,
      cashRoute,
      spendingRoute,
      taxRoute,
      rebalanceRoute,
    ]),
    loginRoute,
  ]);

  return {
    routeTree,
    rootRoute,
    authenticatedRoute,
    dashboardRoute,
    holdingsRoute,
    importsRoute,
    reconcileRoute,
    chatRoute,
    cashRoute,
    spendingRoute,
    taxRoute,
    rebalanceRoute,
    loginRoute,
  };
};

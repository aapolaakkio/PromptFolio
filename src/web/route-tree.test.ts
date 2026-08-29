import { test, expect } from "bun:test";
import { createRouter } from "@tanstack/react-router";
import { buildRouteTree } from "./route-tree";

const Stub = () => null;
const {
  routeTree,
  rootRoute,
  authenticatedRoute,
  dashboardRoute,
  holdingsRoute,
  importsRoute,
  reconcileRoute,
  chatRoute,
  loginRoute,
} = buildRouteTree({
  authenticated: Stub,
  dashboard: Stub,
  holdings: Stub,
  imports: Stub,
  reconcile: Stub,
  chat: Stub,
  login: Stub,
});

// `createRoute`'s `getParentRoute` closure is only *evaluated* -- and
// `.parentRoute`/`.fullPath` only *populated* -- when a router walks the
// tree and calls each route's `.init()` (verified directly against
// `@tanstack/router-core`'s `route.js`/`router.js`). Building a real
// router here, exactly as `router.ts` does for the app, is what makes the
// assertions below meaningful rather than reading `undefined` off
// never-initialised routes.
createRouter({ routeTree });

/**
 * Regression test for a real Critical bug (see route-tree.ts's top
 * comment): /login was nested under the session-gated "authenticated"
 * layout route, so that layout's `if (!session) return null` ran before
 * <Outlet/> -- which is what renders LoginPage -- ever mounted. The URL
 * became /login but nothing rendered there: a permanent blank page with
 * no way to sign in.
 *
 * These assertions inspect the constructed route tree's actual parent
 * pointers rather than rendering anything, so they need no DOM, no
 * network, and no session state -- and they would have failed against
 * the broken tree (where /login's parent was `authenticatedRoute`).
 */
test("the login route is NOT nested under the session-gated layout", () => {
  expect(loginRoute.parentRoute).toBe(rootRoute);
  expect(loginRoute.parentRoute).not.toBe(authenticatedRoute);
});

test("the protected routes ARE nested under the session-gated layout", () => {
  expect(dashboardRoute.parentRoute).toBe(authenticatedRoute);
  expect(holdingsRoute.parentRoute).toBe(authenticatedRoute);
  expect(importsRoute.parentRoute).toBe(authenticatedRoute);
});

test("the pathless layout route resolves to the URLs the app actually serves", () => {
  // Confirms the pathless "authenticated" id-only route contributes no
  // URL segment of its own -- the protected pages keep the exact paths
  // they had before this route was inserted between them and the root.
  expect(dashboardRoute.fullPath).toBe("/");
  expect(holdingsRoute.fullPath).toBe("/holdings");
  expect(importsRoute.fullPath).toBe("/imports");
  expect(loginRoute.fullPath).toBe("/login");
});

// The reconciliation screen is authenticated like every other page: a statement
// says what someone owns, so a signed-out visitor must never reach it. Asserted
// structurally, the same way the login page's placement is -- see this file's
// own note on the blank-login bug that convention exists to prevent.
test("the chat route sits inside the session gate", () => {
  expect(chatRoute.options.getParentRoute?.()).toBe(authenticatedRoute);
  expect(chatRoute.fullPath).toBe("/chat");
});

test("the reconcile route sits inside the session gate", () => {
  expect(reconcileRoute.options.getParentRoute?.()).toBe(authenticatedRoute);
  expect(reconcileRoute.fullPath).toBe("/reconcile");
});

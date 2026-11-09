import { test, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { SessionGate } from "./session-gate.tsx";

const noop = () => {};

/** A signed-out visitor never sees the authenticated nav or page content, asserted on rendered HTML. */
test("pending session renders only the loading text -- no chrome, no content", () => {
  const html = renderToStaticMarkup(
    SessionGate({ isPending: true, hasSession: false, onSignOut: noop }),
  );
  expect(html).toBe('<main class="grid min-h-dvh place-items-center">Loading…</main>');
  expect(html).not.toContain("Sign out");
  expect(html).not.toContain("Holdings");
});

test("resolved with no session renders nothing at all", () => {
  const html = renderToStaticMarkup(
    SessionGate({ isPending: false, hasSession: false, onSignOut: noop }),
  );
  expect(html).toBe("");
});

test("resolved with a session renders the nav, sign-out button and the routed page", async () => {
  // <Outlet/> and <Link/> need a router context; a minimal in-memory one provides it.
  const testRoot = createRootRoute({
    component: () => SessionGate({ isPending: false, hasSession: true, onSignOut: noop }),
  });
  const child = createRoute({
    getParentRoute: () => testRoot,
    path: "/",
    component: () => "PROTECTED_PAGE_MARKER",
  });
  const router = createRouter({
    routeTree: testRoot.addChildren([child]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();

  const html = renderToStaticMarkup(RouterProvider({ router }));

  expect(html).toContain("PromptFolio");
  expect(html).toContain("Sign out");
  expect(html).toContain("Holdings");
  expect(html).toContain("Imports");
  // Forecast sits right after Rebalance in the nav.
  expect(html).toMatch(/>Rebalance<\/a><a[^>]*href="\/forecast"[^>]*>Forecast<\/a>/);
  expect(html).toContain("PROTECTED_PAGE_MARKER");
});

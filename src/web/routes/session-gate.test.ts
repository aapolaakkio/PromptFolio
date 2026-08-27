import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { SessionGate } from "./session-gate";

const noop = () => {};

/**
 * Regression coverage for the "no leak" requirement raised alongside the
 * /login routing bug: a signed-out visitor must never briefly see the
 * authenticated nav bar or protected page content, in either of the two
 * states they can actually be in before the redirect to /login completes.
 * Both are asserted on real rendered HTML (react-dom/server, no DOM, no
 * network, no session) rather than by re-reading the component's source.
 */
test("pending session renders only the loading text -- no chrome, no content", () => {
  const html = renderToStaticMarkup(
    SessionGate({ isPending: true, hasSession: false, onSignOut: noop }),
  );
  expect(html).toBe('<main class="grid min-h-dvh place-items-center">Ladataan…</main>');
  expect(html).not.toContain("Kirjaudu ulos");
  expect(html).not.toContain("Omistukset");
});

test("resolved with no session renders nothing at all", () => {
  const html = renderToStaticMarkup(
    SessionGate({ isPending: false, hasSession: false, onSignOut: noop }),
  );
  expect(html).toBe("");
});

test("resolved with a session renders the nav, sign-out button and the routed page", async () => {
  // <Outlet/> and <Link/> need a real router context to resolve, unlike
  // the two states above -- a minimal one-route in-memory router provides
  // it without needing the app's real route tree or any browser API.
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
  expect(html).toContain("Kirjaudu ulos");
  expect(html).toContain("Omistukset");
  expect(html).toContain("Tuonnit");
  expect(html).toContain("PROTECTED_PAGE_MARKER");
});

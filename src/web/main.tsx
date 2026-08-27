import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DashboardPage } from "./routes/dashboard";
import { HoldingsPage } from "./routes/holdings";
import { ImportsPage } from "./routes/imports";
import { LoginPage } from "./routes/login";
import { RootLayout } from "./routes/root";

const rootRoute = createRootRoute({ component: RootLayout });
const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: "/", component: DashboardPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/holdings", component: HoldingsPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/imports", component: ImportsPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/login", component: LoginPage }),
]);

const router = createRouter({ routeTree });
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 60_000, retry: 1 } },
});

const rootElement = document.getElementById("root");
if (rootElement === null) throw new Error("#root element is missing from index.html");

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);

import { createRouter } from "@tanstack/react-router";

import { routeTree } from "./routeTree.gen.ts";

/** The router Start mounts; `getRouter` is the name its entry resolution looks for. */
export const getRouter = () => createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}

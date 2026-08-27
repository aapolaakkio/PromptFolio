// Task 17 creates src/web/index.html and restores this import plus the
// '/*' route below, which serves the compiled SPA shell for any path that
// isn't an API route. Until then, importing it would fail to resolve.
// import index from "../web/index.html";
import { auth } from "./auth";
import { accountRoutes } from "./api/accounts";
import { instrumentRoutes } from "./api/instruments";

const server = Bun.serve({
  port: Number(Bun.env.PORT ?? 3000),
  development: Bun.env.NODE_ENV !== "production",
  routes: {
    "/api/auth/*": (request) => auth.handler(request),
    ...accountRoutes,
    ...instrumentRoutes,
    // '/*': index, // Task 17 restores this once src/web/index.html exists.
  },
});

console.log(`PromptFolio kuuntelee osoitteessa ${server.url}`);

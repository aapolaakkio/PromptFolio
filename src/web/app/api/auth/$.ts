import { createFileRoute } from "@tanstack/react-router";

import { getAuth } from "../../../../server/auth.ts";

// Better Auth owns every path under /api/auth.
const handler = ({ request }: { request: Request }) => getAuth().handler(request);

export const Route = createFileRoute("/api/auth/$")({
  server: { handlers: { GET: handler, POST: handler } },
});

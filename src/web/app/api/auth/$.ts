import { createFileRoute } from "@tanstack/react-router";

import { getAuth } from "../../../../server/auth.ts";

// Better Auth owns every path under /api/auth: sign-up, sign-in, sign-out and
// the session endpoint the pages read.
const handler = ({ request }: { request: Request }) => getAuth().handler(request);

export const Route = createFileRoute("/api/auth/$")({
  server: { handlers: { GET: handler, POST: handler } },
});

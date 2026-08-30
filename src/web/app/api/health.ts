import { createFileRoute } from "@tanstack/react-router";

/**
 * Liveness for the container's healthcheck and any uptime monitor.
 *
 * Deliberately touches no database: a slow or locked SQLite file -- a WAL
 * checkpoint, a long import -- must not read as unhealthy and restart a
 * container that is otherwise fine. Unauthenticated for the same kind of reason:
 * a check that needs a session cookie cannot be run by `docker inspect`.
 */
export const Route = createFileRoute("/api/health")({
  server: { handlers: { GET: () => Response.json({ ok: true }) } },
});

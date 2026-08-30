import { createFileRoute } from "@tanstack/react-router";

import { ReconcilePage } from "../../routes/reconcile.tsx";

export const Route = createFileRoute("/_authenticated/reconcile")({ component: ReconcilePage });

import { createFileRoute } from "@tanstack/react-router";

import { DashboardPage } from "../../routes/dashboard.tsx";

export const Route = createFileRoute("/_authenticated/")({ component: DashboardPage });

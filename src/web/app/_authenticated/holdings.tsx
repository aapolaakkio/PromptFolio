import { createFileRoute } from "@tanstack/react-router";

import { HoldingsPage } from "../../routes/holdings.tsx";

export const Route = createFileRoute("/_authenticated/holdings")({ component: HoldingsPage });

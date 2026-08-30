import { createFileRoute } from "@tanstack/react-router";

import { RebalancePage } from "../../routes/rebalance.tsx";

export const Route = createFileRoute("/_authenticated/rebalance")({ component: RebalancePage });

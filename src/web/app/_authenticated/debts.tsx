import { createFileRoute } from "@tanstack/react-router";

import { DebtsPage } from "../../routes/debts.tsx";

export const Route = createFileRoute("/_authenticated/debts")({ component: DebtsPage });

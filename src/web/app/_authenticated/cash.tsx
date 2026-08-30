import { createFileRoute } from "@tanstack/react-router";

import { CashPage } from "../../routes/cash.tsx";

export const Route = createFileRoute("/_authenticated/cash")({ component: CashPage });

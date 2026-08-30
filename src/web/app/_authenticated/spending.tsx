import { createFileRoute } from "@tanstack/react-router";

import { SpendingPage } from "../../routes/spending.tsx";

export const Route = createFileRoute("/_authenticated/spending")({ component: SpendingPage });

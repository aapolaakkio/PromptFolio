import { createFileRoute } from "@tanstack/react-router";

import { TaxPage } from "../../routes/tax.tsx";

export const Route = createFileRoute("/_authenticated/tax")({ component: TaxPage });

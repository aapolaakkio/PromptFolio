import { createFileRoute } from "@tanstack/react-router";

import { ImportsPage } from "../../routes/imports.tsx";

export const Route = createFileRoute("/_authenticated/imports")({ component: ImportsPage });

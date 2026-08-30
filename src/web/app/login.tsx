import { createFileRoute } from "@tanstack/react-router";

import { LoginPage } from "../routes/login.tsx";

// Outside the authenticated layout, which is the whole point of it.
export const Route = createFileRoute("/login")({ component: LoginPage });

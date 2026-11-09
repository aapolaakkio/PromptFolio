import { createFileRoute } from "@tanstack/react-router";

import { LoginPage } from "../routes/login.tsx";

export const Route = createFileRoute("/login")({ component: LoginPage });

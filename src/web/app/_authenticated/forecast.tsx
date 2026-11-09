import { createFileRoute } from "@tanstack/react-router";

import { ForecastPage } from "../../routes/forecast.tsx";

export const Route = createFileRoute("/_authenticated/forecast")({ component: ForecastPage });

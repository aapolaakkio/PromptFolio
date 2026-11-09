import { ForecastCard } from "./ForecastCard.tsx";
import { MonthlyPlan } from "./MonthlyPlan.tsx";

/** What the owner saves each month, and where that and today's holdings may lead. */
export const ForecastPage = () => (
  <>
    <h1>Forecast</h1>
    <MonthlyPlan />
    <ForecastCard />
  </>
);

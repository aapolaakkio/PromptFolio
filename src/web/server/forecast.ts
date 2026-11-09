import { createServerFn } from "@tanstack/react-start";

import { db } from "../../server/db/index.ts";
import { forecastFor } from "../../server/forecast.ts";
import {
  ForecastOptionsInput,
  ForecastRateInput,
  ForecastRateRemoveInput,
} from "../../server/forecast-inputs.ts";
import { removeRateOverride, setRateOverride } from "../../server/forecast-rates.ts";
import { authed, readable } from "./guard.ts";

/** The caller's holdings, rates and monthly plan, projected forward. */
export const getForecast = createServerFn()
  .middleware([authed])
  .validator(ForecastOptionsInput)
  .handler(({ data, context }) => forecastFor(db, context.userId, data));

/** The owner's own yearly rate for one instrument, replacing the measured one. */
export const saveForecastRate = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(ForecastRateInput)
  .handler(({ data, context }) => readable(() => setRateOverride(db, context.userId, data)));

export const deleteForecastRate = createServerFn({ method: "POST" })
  .middleware([authed])
  .validator(ForecastRateRemoveInput)
  .handler(({ data, context }) => removeRateOverride(db, context.userId, data.instrumentId));

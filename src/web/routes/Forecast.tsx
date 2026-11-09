import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { ForecastHoldingView } from "../../server/forecast.ts";
import { ForecastChart } from "../charts/ForecastChart.tsx";
import { errorMessage } from "../lib/errors.ts";
import { eur, share } from "../lib/format.ts";
import { deleteForecastRate, getForecast, saveForecastRate } from "../server/forecast.ts";

export const FORECAST_QUERY_KEY = ["forecast"];

const HORIZONS = [1, 5, 10, 20] as const;

const basisText = (row: ForecastHoldingView): string => {
  const years = row.yearsOfHistory.toFixed(1);
  switch (row.basis) {
    case "user":
      return "your rate";
    case "history":
      return `from ${years} y of prices`;
    case "blend":
      return `${years} y of prices, blended with the default`;
    case "default":
      return row.kind === "cash" ? "cash default" : "default, too little history";
  }
};

/** A rate as the percentage the owner types, e.g. 0.065 as "6.50". */
const percentText = (rate: number): string => (rate * 100).toFixed(2);

const RateCell = ({
  row,
  onError,
}: {
  row: ForecastHoldingView;
  onError: (text: string | null) => void;
}) => {
  const queryClient = useQueryClient();
  const refresh = () => {
    onError(null);
    return queryClient.invalidateQueries({ queryKey: FORECAST_QUERY_KEY });
  };
  const save = useMutation({
    mutationFn: (ratePercent: string) =>
      saveForecastRate({ data: { instrumentId: row.instrumentId, ratePercent } }),
    onSuccess: refresh,
    onError: (cause) => onError(errorMessage(cause, "Could not save the rate")),
  });
  const remove = useMutation({
    mutationFn: () => deleteForecastRate({ data: { instrumentId: row.instrumentId } }),
    onSuccess: refresh,
    onError: (cause) => onError(errorMessage(cause, "Could not reset the rate")),
  });
  return (
    <td className="text-right">
      <input
        // Remounts with the stored rate after a save or a refused edit.
        key={`${row.rate}-${row.basis}`}
        defaultValue={percentText(row.rate)}
        inputMode="decimal"
        aria-label={`${row.name} expected yearly growth in percent`}
        className="w-20 px-2 py-1 text-right text-sm"
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        onBlur={(event) => {
          const value = event.target.value.trim();
          if (value === "" && row.basis === "user") remove.mutate();
          else if (value !== "" && value !== percentText(row.rate)) save.mutate(value);
        }}
      />{" "}
      %
      <span className="block text-xs text-muted">
        {basisText(row)}
        {row.basis === "user" && (
          <button
            type="button"
            className="quiet-button"
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
          >
            Reset
          </button>
        )}
      </span>
    </td>
  );
};

/** Where the portfolio may be in 1–20 years, from past prices and the monthly plan. */
export const Forecast = () => {
  const [years, setYears] = useState<(typeof HORIZONS)[number]>(10);
  const [real, setReal] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const forecast = useQuery({
    queryKey: [...FORECAST_QUERY_KEY, years, real],
    queryFn: () => getForecast({ data: { months: years * 12, real } }),
  });
  const data = forecast.data;
  const end = data?.result.points[data.result.points.length - 1];

  return (
    <section className="card mt-8">
      <h2 className="mb-2 text-lg font-semibold">Forecast</h2>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        {HORIZONS.map((horizon) => (
          <button
            key={horizon}
            type="button"
            aria-pressed={years === horizon}
            className={`quiet-button ${years === horizon ? "text-accent font-medium" : ""}`}
            onClick={() => setYears(horizon)}
          >
            {horizon} {horizon === 1 ? "year" : "years"}
          </button>
        ))}
        <label className="mb-0 ml-auto flex items-center gap-2">
          <input
            type="checkbox"
            checked={real}
            onChange={(event) => setReal(event.target.checked)}
          />
          In today's euros
        </label>
      </div>
      {forecast.isPending && <p>Loading…</p>}
      {forecast.isError && (
        <p className="text-sm text-loss">{errorMessage(forecast.error, "Could not forecast")}</p>
      )}
      {data !== undefined && data.holdings.length === 0 && (
        <p className="text-muted">
          Nothing to forecast yet: no valued holdings and no monthly plan.
        </p>
      )}
      {data !== undefined && data.holdings.length > 0 && end !== undefined && (
        <>
          <ForecastChart points={data.result.points} />
          <p className="mt-2 text-sm text-muted">
            An estimate from past prices and your monthly plan, not a promise. The shaded area is a
            rough range: it treats every holding as moving together, so it is wider than the likely
            spread.
            {real &&
              ` Amounts are in today's euros at ${share(data.result.inflation)} inflation a year.`}
          </p>
          <p className="mt-2 font-semibold">
            In {years} {years === 1 ? "year" : "years"}: {eur(String(end.total.expected))} (
            {eur(String(end.total.low))} – {eur(String(end.total.high))}), of which you put in{" "}
            {eur(String(end.contributedEur))}.
          </p>
          <table className="mt-3 text-sm">
            <thead>
              <tr>
                <th>Holding</th>
                <th className="text-right">Value today</th>
                <th className="text-right">Per month</th>
                <th className="text-right">Yearly growth</th>
                <th className="text-right">In {years} y, expected</th>
                <th className="text-right">Range</th>
              </tr>
            </thead>
            <tbody>
              {data.holdings.map((row, index) => {
                const atEnd = end.holdings[index];
                return (
                  <tr key={row.instrumentId}>
                    <td>{row.name}</td>
                    <td className="num">{eur(String(row.valueEur))}</td>
                    <td className="num">
                      {row.monthlyEur > 0 ? eur(String(row.monthlyEur)) : "—"}
                    </td>
                    <RateCell row={row} onError={setError} />
                    <td className="num">
                      {atEnd === undefined ? "—" : eur(String(atEnd.expected))}
                    </td>
                    <td className="num text-muted">
                      {atEnd === undefined
                        ? "—"
                        : `${eur(String(atEnd.low))} – ${eur(String(atEnd.high))}`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-muted">
            Type your own yearly growth to replace the measured one; clear it or press Reset to go
            back.
          </p>
          {data.unvalued.length > 0 && (
            <p className="mt-2 text-sm text-muted">
              Left out, no price today: {data.unvalued.join(", ")}.
            </p>
          )}
        </>
      )}
      {error !== null && <p className="mt-2 text-sm text-loss">{error}</p>}
    </section>
  );
};

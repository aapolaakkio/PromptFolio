import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { errorMessage } from "../lib/errors.ts";
import { FORECAST_QUERY_KEY } from "./Forecast.tsx";
import { eur } from "../lib/format.ts";
import { getInstruments } from "../server/instruments.ts";
import { deletePlanRow, getMonthlyPlan, savePlanRow } from "../server/rebalance.ts";

const QUERY_KEY = ["monthly-plan"];

/** What the owner invests each month, typed by hand; the orders themselves run at the broker. */
export const MonthlyPlan = () => {
  const queryClient = useQueryClient();
  const plan = useQuery({ queryKey: QUERY_KEY, queryFn: () => getMonthlyPlan() });
  const instruments = useQuery({ queryKey: ["instruments"], queryFn: () => getInstruments() });
  const [instrumentId, setInstrumentId] = useState("");
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (row: { instrumentId: number; amountEur: string }) => savePlanRow({ data: row }),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: FORECAST_QUERY_KEY });
      return queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
    onError: (cause) => setError(errorMessage(cause, "Could not save")),
  });
  const remove = useMutation({
    mutationFn: (id: number) => deletePlanRow({ data: { instrumentId: id } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: FORECAST_QUERY_KEY });
      return queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
    onError: (cause) => setError(errorMessage(cause, "Could not remove")),
  });

  const rows = plan.data?.rows ?? [];
  const canAdd = instrumentId !== "" && amount.trim() !== "" && !save.isPending;

  return (
    <section className="card mt-8">
      <h2 className="mb-2 text-lg font-semibold">Monthly plan</h2>
      <p className="text-sm text-muted">
        What you invest each month. The orders run at your broker; this only records the plan.
      </p>
      {plan.data !== undefined && rows.length === 0 && (
        <p className="mt-2 text-muted">No monthly plan yet. Add an instrument and a sum below.</p>
      )}
      {rows.length > 0 && (
        <table className="mt-2 w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-line text-left text-muted">
              <th className="py-2">Instrument</th>
              <th>ISIN</th>
              <th className="text-right">Per month</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.instrumentId} className="border-b border-line">
                <td className="py-2">{row.name}</td>
                <td className="text-muted">{row.isin ?? "—"}</td>
                <td className="text-right">
                  <input
                    // Remounts with the stored sum after a save or a refused edit.
                    key={row.amountEur}
                    defaultValue={row.amountEur}
                    inputMode="decimal"
                    aria-label={`${row.name} per month in euros`}
                    className="w-28 border border-line bg-surface px-2 py-1 text-right"
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
                    }}
                    onBlur={(event) => {
                      const value = event.target.value.trim();
                      if (value !== row.amountEur) {
                        save.mutate({ instrumentId: row.instrumentId, amountEur: value });
                      }
                    }}
                  />
                </td>
                <td className="text-right">
                  <button
                    type="button"
                    className="quiet-button"
                    aria-label={`Remove ${row.name} from the plan`}
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(row.instrumentId)}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {plan.data !== undefined && rows.length > 0 && (
        <p className="mt-2 font-semibold">{eur(plan.data.totalEur)} per month</p>
      )}
      <form
        className="mt-3 flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate(
            { instrumentId: Number(instrumentId), amountEur: amount.trim() },
            {
              onSuccess: () => {
                setInstrumentId("");
                setAmount("");
              },
            },
          );
        }}
      >
        <select
          value={instrumentId}
          aria-label="Instrument to add"
          className="border border-line bg-surface px-2 py-1"
          onChange={(event) => setInstrumentId(event.target.value)}
        >
          <option value="">Instrument…</option>
          {(instruments.data ?? []).map((instrument) => (
            <option key={instrument.id} value={instrument.id}>
              {instrument.isin === null
                ? instrument.name
                : `${instrument.name} (${instrument.isin})`}
            </option>
          ))}
        </select>
        <input
          value={amount}
          inputMode="decimal"
          placeholder="Per month"
          aria-label="Amount per month in euros"
          className="w-28 border border-line bg-surface px-2 py-1 text-right"
          onChange={(event) => setAmount(event.target.value)}
        />
        <span>€</span>
        <button type="submit" disabled={!canAdd}>
          Add
        </button>
      </form>
      {error !== null && <p className="mt-2 text-sm text-loss">{error}</p>}
    </section>
  );
};

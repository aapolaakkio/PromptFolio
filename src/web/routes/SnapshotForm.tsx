import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { errorMessage } from "../lib/errors.ts";
import { saveSnapshot } from "../server/snapshots.ts";
import { getInstruments } from "../server/instruments.ts";

/** Records a broker statement's holdings on a date by hand. Only filled rows are sent: blank means "not mentioned", not "zero", and reconciliation treats them differently. */
export const SnapshotForm = ({
  accountId,
  onCreated,
}: {
  readonly accountId: number;
  readonly onCreated: (snapshotId: number) => void;
}) => {
  const queryClient = useQueryClient();
  const [asOf, setAsOf] = useState("");
  const [quantities, setQuantities] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);

  const instruments = useQuery({
    queryKey: ["instruments"],
    queryFn: () => getInstruments(),
  });

  const filled = Object.entries(quantities).filter(([, value]) => value.trim() !== "");

  const create = useMutation({
    mutationFn: () =>
      saveSnapshot({
        data: {
          accountId,
          asOf,
          source: "manual" as const,
          rows: filled.map(([instrumentId, quantity]) => ({
            instrumentId: Number(instrumentId),
            quantity: quantity.trim().replace(",", "."),
          })),
        },
      }),
    onSuccess: (snapshot) => {
      setError(null);
      setQuantities({});
      void queryClient.invalidateQueries({ queryKey: ["snapshots", accountId] });
      onCreated(snapshot.id);
    },
    onError: (cause) => {
      setError(errorMessage(cause, "Could not save the statement"));
    },
  });

  return (
    <form
      className="card mt-6"
      onSubmit={(event) => {
        event.preventDefault();
        create.mutate();
      }}
    >
      <h2>Add a statement by hand</h2>
      <p className="text-muted">
        Enter only the rows the statement lists. A blank field means the statement does not mention
        that instrument — which is not the same as zero.
      </p>

      <label className="mt-3 block">
        Statement date
        <input type="date" value={asOf} required onChange={(e) => setAsOf(e.target.value)} />
      </label>

      <div className="mt-3 max-h-80 overflow-auto rounded border border-line">
        <table>
          <thead className="sticky top-0 bg-surface">
            <tr>
              <th>Instrument</th>
              <th className="num">Quantity on statement</th>
            </tr>
          </thead>
          <tbody>
            {(instruments.data ?? []).map((instrument) => (
              <tr key={instrument.id}>
                <td>{instrument.name}</td>
                <td className="num">
                  <input
                    value={quantities[instrument.id] ?? ""}
                    inputMode="decimal"
                    placeholder="—"
                    onChange={(e) =>
                      setQuantities((current) => ({ ...current, [instrument.id]: e.target.value }))
                    }
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {error && (
        <p role="alert" className="text-loss mt-3 text-sm">
          {error}
        </p>
      )}

      <button type="submit" className="mt-4" disabled={filled.length === 0 || create.isPending}>
        {create.isPending ? "Saving…" : `Save statement (${filled.length} rows)`}
      </button>
    </form>
  );
};

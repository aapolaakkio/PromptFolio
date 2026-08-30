import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";

import { ApiError, apiGet, apiPost } from "../lib/api.ts";

const InstrumentSchema = z.object({ id: z.number(), name: z.string() });
const CreatedSnapshotSchema = z.object({ id: z.number() });

/**
 * Records what a broker's statement says was held on a date. Typed in by hand
 * here; the PDF and photo paths (spec §5.2) produce exactly the same shape.
 *
 * Only the rows the user actually fills in are sent. A blank field means "the
 * statement does not mention this holding", which is a different claim from
 * "the statement says zero" -- and the reconciliation treats them differently,
 * so the form must not quietly turn one into the other.
 */
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
    queryFn: () => apiGet("/api/instruments", z.array(InstrumentSchema)),
  });

  const filled = Object.entries(quantities).filter(([, value]) => value.trim() !== "");

  const create = useMutation({
    mutationFn: () =>
      apiPost(
        "/api/snapshots",
        {
          accountId,
          asOf,
          source: "manual" as const,
          rows: filled.map(([instrumentId, quantity]) => ({
            instrumentId: Number(instrumentId),
            quantity: quantity.trim().replace(",", "."),
          })),
        },
        CreatedSnapshotSchema,
      ),
    onSuccess: (snapshot) => {
      setError(null);
      setQuantities({});
      void queryClient.invalidateQueries({ queryKey: ["snapshots", accountId] });
      onCreated(snapshot.id);
    },
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : "Otteen tallennus epäonnistui");
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
      <h2>Lisää ote käsin</h2>
      <p className="text-muted">
        Syötä vain ne rivit, jotka otteella lukevat. Tyhjä kenttä tarkoittaa, ettei otteella mainita
        kyseistä arvopaperia — se ei ole sama asia kuin nolla.
      </p>

      <label className="mt-3 block">
        Otteen päivä
        <input type="date" value={asOf} required onChange={(e) => setAsOf(e.target.value)} />
      </label>

      <div className="mt-3 max-h-80 overflow-auto rounded border border-line">
        <table>
          <thead className="sticky top-0 bg-surface">
            <tr>
              <th>Arvopaperi</th>
              <th className="num">Määrä otteella</th>
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
        {create.isPending ? "Tallennetaan…" : `Tallenna ote (${filled.length} riviä)`}
      </button>
    </form>
  );
};

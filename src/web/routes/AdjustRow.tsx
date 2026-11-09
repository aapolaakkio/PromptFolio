import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { errorMessage } from "../lib/errors.ts";
import { adjustSnapshot } from "../server/snapshots.ts";
import type { ReconcileRow } from "./reconcile-view.ts";

/** Turns one accepted difference into a transaction, per row, never bulk: an adjustment has no broker record. Adding units requires the acquisition value (server enforces it too): a zero cost basis reports the whole value as gain. */
export const AdjustRow = ({
  snapshotId,
  row,
}: {
  readonly snapshotId: number;
  readonly row: ReconcileRow;
}) => {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [costEur, setCostEur] = useState("");
  const [error, setError] = useState<string | null>(null);

  const adding = Number(row.delta) > 0;

  const adjust = useMutation({
    mutationFn: () =>
      adjustSnapshot({
        data: adding
          ? {
              snapshotId,
              instrumentId: row.instrumentId,
              costEur: costEur.trim().replace(",", "."),
            }
          : { snapshotId, instrumentId: row.instrumentId },
      }),
    onSuccess: () => {
      setError(null);
      setOpen(false);
      void queryClient.invalidateQueries({ queryKey: ["reconcile", snapshotId] });
      void queryClient.invalidateQueries({ queryKey: ["holdings"] });
    },
    onError: (cause) => {
      setError(errorMessage(cause, "Adjustment failed"));
    },
  });

  if (!open) {
    return (
      <button type="button" className="text-sm" onClick={() => setOpen(true)}>
        Adjust
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {adding && (
        <label className="text-xs">
          Cost basis (€)
          <input
            value={costEur}
            inputMode="decimal"
            required
            placeholder="e.g. 500.00"
            onChange={(e) => setCostEur(e.target.value)}
          />
        </label>
      )}
      <p className="text-xs text-muted">
        {adding
          ? "Records the units that arrived. The cost basis is not guessed: without it, later returns would show the whole value as profit."
          : "Records the units that left, with no sale proceeds."}
      </p>
      {error && (
        <p role="alert" className="text-loss text-xs">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          className="text-sm"
          disabled={adjust.isPending || (adding && costEur.trim() === "")}
          onClick={() => adjust.mutate()}
        >
          {adjust.isPending ? "Recording…" : "Confirm adjustment"}
        </button>
        <button type="button" className="text-sm" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
};

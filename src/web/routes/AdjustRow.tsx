import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { qty } from "../lib/format.ts";
import { errorMessage } from "../lib/errors.ts";
import { adjustSnapshot } from "../server/snapshots.ts";
import type { ReconcileRow } from "./reconcile-view.ts";

/** Turns one accepted difference into a transaction, per row, never bulk: an adjustment has no broker record. Adding units requires the acquisition value (server enforces it too): a zero cost basis reports the whole value as gain. */
export const AdjustRow = ({
  snapshotId,
  row,
  suggested = false,
}: {
  readonly snapshotId: number;
  readonly row: ReconcileRow;
  /** A checked AI suggestion equals the adjustment this form books; it opens the form but the owner still confirms. */
  readonly suggested?: boolean;
}) => {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(suggested);
  // A later suggestion opens the form without remounting it, so a typed cost basis survives.
  useEffect(() => {
    if (suggested) setOpen(true);
  }, [suggested]);
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
      {suggested && (
        <p className="text-xs">
          AI suggestion: book {qty(row.delta)} units {adding ? "in" : "out"}, dated on the
          statement.
        </p>
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

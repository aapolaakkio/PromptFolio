import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";

import { ApiError, apiPost } from "../lib/api";
import type { ReconcileRow } from "./reconcile-view";

const AdjustedSchema = z.object({ id: z.number() });

/**
 * Turns one accepted difference into a transaction. Deliberately per row and
 * never in bulk: an adjustment has no broker record behind it, so each one is a
 * separate decision rather than a single "fix everything" the user cannot
 * inspect afterwards.
 *
 * Adding units asks for the acquisition value and will not proceed without it.
 * The server refuses a missing cost too -- this is the same rule stated twice,
 * on purpose, because a zero cost basis reports a holding's entire value as
 * gain and nothing downstream would flag it.
 */
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
      apiPost(
        `/api/snapshots/${snapshotId}/adjust`,
        adding
          ? { instrumentId: row.instrumentId, costEur: costEur.trim().replace(",", ".") }
          : { instrumentId: row.instrumentId },
        AdjustedSchema,
      ),
    onSuccess: () => {
      setError(null);
      setOpen(false);
      void queryClient.invalidateQueries({ queryKey: ["reconcile", snapshotId] });
      void queryClient.invalidateQueries({ queryKey: ["holdings"] });
    },
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : "Korjaus epäonnistui");
    },
  });

  if (!open) {
    return (
      <button type="button" className="text-sm" onClick={() => setOpen(true)}>
        Korjaa
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {adding && (
        <label className="text-xs">
          Hankintameno (€)
          <input
            value={costEur}
            inputMode="decimal"
            required
            placeholder="esim. 500,00"
            onChange={(e) => setCostEur(e.target.value)}
          />
        </label>
      )}
      <p className="text-xs text-muted">
        {adding
          ? "Kirjataan saapuneet osuudet. Hankintamenoa ei arvata: ilman sitä myöhempi tuotto näyttäisi koko arvon voittona."
          : "Kirjataan poistuneet osuudet ilman myyntituloa."}
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
          {adjust.isPending ? "Kirjataan…" : "Vahvista korjaus"}
        </button>
        <button type="button" className="text-sm" onClick={() => setOpen(false)}>
          Peruuta
        </button>
      </div>
    </div>
  );
};

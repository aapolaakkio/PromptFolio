import { useState } from "react";
import { getAccounts } from "../server/accounts.ts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  explainDifferences,
  getReconciliation,
  getSnapshots,
  removeSnapshot,
} from "../server/snapshots.ts";
import { formatDate, qty } from "../lib/format.ts";
import { AdjustRow } from "./AdjustRow.tsx";
import { SnapshotForm } from "./SnapshotForm.tsx";
import { SnapshotPaste } from "./SnapshotPaste.tsx";
import { explain, needsAttention, type ReconcileRow } from "./reconcile-view.ts";

const SOURCE_LABELS = new Map<string, string>([
  ["pdf", "PDF statement"],
  ["vision", "Image"],
  ["manual", "Entered by hand"],
]);

/** Compares a broker statement with what the ledger derives for that day. Read-only: an adjusting transaction is a separate, deliberate act. */
export const ReconcilePage = () => {
  const queryClient = useQueryClient();
  const [accountId, setAccountId] = useState<number | null>(null);
  const [snapshotId, setSnapshotId] = useState<number | null>(null);

  const accounts = useQuery({
    queryKey: ["accounts"],
    queryFn: () => getAccounts(),
  });

  const chosenAccount = accountId ?? accounts.data?.[0]?.id ?? null;

  const snapshots = useQuery({
    queryKey: ["snapshots", chosenAccount],
    enabled: chosenAccount !== null,
    queryFn: () => getSnapshots({ data: { accountId: chosenAccount ?? 0 } }),
  });

  const chosenSnapshot = snapshotId ?? snapshots.data?.at(-1)?.id ?? null;

  const remove = useMutation({
    mutationFn: (id: number) => removeSnapshot({ data: { snapshotId: id } }),
    onSuccess: () => {
      setSnapshotId(null);
      void queryClient.invalidateQueries({ queryKey: ["snapshots", chosenAccount] });
    },
  });

  const reconciliation = useQuery({
    queryKey: ["reconcile", chosenSnapshot],
    enabled: chosenSnapshot !== null,
    queryFn: () => getReconciliation({ data: { snapshotId: chosenSnapshot ?? 0 } }),
  });

  return (
    <section>
      <h1>Reconcile</h1>
      <p className="text-muted">
        Compares the broker's statement with what the ledger derives for the same day. This view
        changes nothing — resolving a difference is up to you.
      </p>

      <div className="mt-4 flex flex-wrap gap-4">
        <label>
          Account
          <select
            value={chosenAccount ?? ""}
            onChange={(e) => {
              setAccountId(Number(e.target.value));
              setSnapshotId(null);
            }}
          >
            {(accounts.data ?? []).map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </select>
        </label>

        <label>
          Statement
          <select
            value={chosenSnapshot ?? ""}
            onChange={(e) => setSnapshotId(Number(e.target.value))}
          >
            {(snapshots.data ?? []).map((snapshot) => (
              <option key={snapshot.id} value={snapshot.id}>
                {formatDate(snapshot.asOf)} ·{" "}
                {SOURCE_LABELS.get(snapshot.source) ?? snapshot.source}
              </option>
            ))}
          </select>
        </label>

        {chosenSnapshot !== null && (
          <button
            type="button"
            className="self-end"
            disabled={remove.isPending}
            onClick={() => {
              // Deleting a statement leaves its adjustments in place; the prompt says so.
              if (
                globalThis.confirm(
                  "Delete this statement? Adjustments made from it stay in effect.",
                )
              ) {
                remove.mutate(chosenSnapshot);
              }
            }}
          >
            Delete statement
          </button>
        )}
      </div>

      {snapshots.isSuccess && snapshots.data.length === 0 && (
        <p className="mt-6 text-muted">
          This account has no statements yet. Add one to see the differences.
        </p>
      )}

      {reconciliation.isError && (
        <p role="alert" className="text-loss mt-4">
          Could not load the reconciliation.
        </p>
      )}

      {reconciliation.data && (
        <Result
          rows={reconciliation.data.rows}
          asOf={reconciliation.data.asOf}
          snapshotId={reconciliation.data.snapshotId}
        />
      )}

      {chosenAccount !== null && (
        <>
          <SnapshotPaste accountId={chosenAccount} onCreated={(id) => setSnapshotId(id)} />
          <SnapshotForm accountId={chosenAccount} onCreated={(id) => setSnapshotId(id)} />
        </>
      )}
    </section>
  );
};

const Result = ({
  rows,
  asOf,
  snapshotId,
}: {
  readonly rows: readonly ReconcileRow[];
  readonly asOf: string;
  readonly snapshotId: number;
}) => {
  const attention = needsAttention(rows);
  const explained = useMutation({ mutationFn: () => explainDifferences({ data: { snapshotId } }) });
  const aiById = new Map((explained.data?.explanations ?? []).map((e) => [e.instrumentId, e]));

  return (
    <>
      <p className="mt-6">
        {attention.length === 0
          ? `All ${rows.length} rows match on ${formatDate(asOf)}.`
          : `${attention.length} / ${rows.length} rows differ on ${formatDate(asOf)}.`}
      </p>

      {attention.length > 0 && (
        <div className="mt-3 flex items-center gap-3">
          <button type="button" disabled={explained.isPending} onClick={() => explained.mutate()}>
            {explained.isPending ? "Explaining…" : "Explain differences"}
          </button>
          {(explained.isError || explained.data?.failed === true) && (
            <p role="alert" className="text-loss text-sm">
              Could not explain right now
            </p>
          )}
        </div>
      )}

      <div className="mt-3 max-h-112 overflow-auto rounded border border-line">
        <table>
          <thead className="sticky top-0 bg-surface">
            <tr>
              <th>Instrument</th>
              <th className="num">Ledger</th>
              <th className="num">Statement</th>
              <th className="num">Difference</th>
              <th>Explanation</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const ai = aiById.get(row.instrumentId);
              const suggested = ai?.adjustment != null;
              return (
                <tr key={row.instrumentId}>
                  <td>{row.name ?? `#${row.instrumentId}`}</td>
                  <td className="num">{qty(row.derived)}</td>
                  <td className="num">{qty(row.snapshot)}</td>
                  <td className="num">{row.withinTolerance ? "—" : qty(row.delta)}</td>
                  <td className={row.withinTolerance ? "text-muted" : "text-loss"}>
                    {explain(row)}
                    {ai && <p className="mt-1 text-xs text-muted">AI suggestion: {ai.cause}</p>}
                  </td>
                  <td>
                    {!row.withinTolerance && (
                      <AdjustRow
                        key={String(suggested)}
                        snapshotId={snapshotId}
                        row={row}
                        suggested={suggested}
                      />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
};

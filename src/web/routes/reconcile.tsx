import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";

import { apiDelete, apiGet } from "../lib/api";
import { fiDate, qty } from "../lib/format";
import { AccountsSchema } from "./imports-draft";
import { AdjustRow } from "./AdjustRow";
import { SnapshotForm } from "./SnapshotForm";
import { SnapshotPaste } from "./SnapshotPaste";
import {
  explain,
  needsAttention,
  ReconcileSchema,
  SnapshotSchema,
  type ReconcileRow,
} from "./reconcile-view";

const SOURCE_LABELS = new Map<string, string>([
  ["pdf", "PDF-ote"],
  ["vision", "Kuva"],
  ["manual", "Syötetty käsin"],
]);

/**
 * Compares a broker's holdings statement against what the ledger derives for the
 * same day. Read-only on purpose: this screen reports differences and resolves
 * none of them. Turning a difference into an adjusting transaction is a separate,
 * deliberate act -- an adjustment has no broker record behind it, so it must
 * never happen as a side effect of looking at a statement.
 */
export const ReconcilePage = () => {
  const queryClient = useQueryClient();
  const [accountId, setAccountId] = useState<number | null>(null);
  const [snapshotId, setSnapshotId] = useState<number | null>(null);

  const accounts = useQuery({
    queryKey: ["accounts"],
    queryFn: () => apiGet("/api/accounts", AccountsSchema),
  });

  const chosenAccount = accountId ?? accounts.data?.[0]?.id ?? null;

  const snapshots = useQuery({
    queryKey: ["snapshots", chosenAccount],
    enabled: chosenAccount !== null,
    queryFn: () => apiGet(`/api/snapshots?accountId=${chosenAccount}`, z.array(SnapshotSchema)),
  });

  const chosenSnapshot = snapshotId ?? snapshots.data?.at(-1)?.id ?? null;

  const remove = useMutation({
    mutationFn: (id: number) => apiDelete(`/api/snapshots/${id}`),
    onSuccess: () => {
      setSnapshotId(null);
      void queryClient.invalidateQueries({ queryKey: ["snapshots", chosenAccount] });
    },
  });

  const reconciliation = useQuery({
    queryKey: ["reconcile", chosenSnapshot],
    enabled: chosenSnapshot !== null,
    queryFn: () => apiGet(`/api/snapshots/${chosenSnapshot}/reconcile`, ReconcileSchema),
  });

  return (
    <section>
      <h1>Täsmäytys</h1>
      <p className="text-muted">
        Vertaa välittäjän otetta siihen, mitä kirjanpito johtaa samalle päivälle. Tämä näkymä ei
        muuta mitään — ero on sinun ratkaistavasi.
      </p>

      <div className="mt-4 flex flex-wrap gap-4">
        <label>
          Tili
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
          Ote
          <select
            value={chosenSnapshot ?? ""}
            onChange={(e) => setSnapshotId(Number(e.target.value))}
          >
            {(snapshots.data ?? []).map((snapshot) => (
              <option key={snapshot.id} value={snapshot.id}>
                {fiDate(snapshot.asOf)} · {SOURCE_LABELS.get(snapshot.source) ?? snapshot.source}
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
              // Deleting a statement leaves any adjustment it produced in place,
              // so this is not a destructive act on the ledger -- said plainly
              // rather than left to be discovered.
              if (
                globalThis.confirm(
                  "Poistetaanko tämä ote? Sen perusteella tehdyt korjaukset jäävät voimaan.",
                )
              ) {
                remove.mutate(chosenSnapshot);
              }
            }}
          >
            Poista ote
          </button>
        )}
      </div>

      {snapshots.isSuccess && snapshots.data.length === 0 && (
        <p className="mt-6 text-muted">
          Tälle tilille ei ole vielä yhtään otetta. Lisää ote, niin näet erot.
        </p>
      )}

      {reconciliation.isError && (
        <p role="alert" className="text-loss mt-4">
          Täsmäytystä ei voitu hakea.
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

  return (
    <>
      <p className="mt-6">
        {attention.length === 0
          ? `Kaikki ${rows.length} riviä täsmäävät ${fiDate(asOf)}.`
          : `${attention.length} / ${rows.length} riviä eroaa ${fiDate(asOf)}.`}
      </p>

      <div className="mt-3 max-h-[28rem] overflow-auto rounded border border-line">
        <table>
          <thead className="sticky top-0 bg-surface">
            <tr>
              <th>Arvopaperi</th>
              <th className="num">Kirjanpito</th>
              <th className="num">Ote</th>
              <th className="num">Ero</th>
              <th>Selitys</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.instrumentId}>
                <td>{row.name ?? `#${row.instrumentId}`}</td>
                <td className="num">{qty(row.derived)}</td>
                <td className="num">{qty(row.snapshot)}</td>
                <td className="num">{row.withinTolerance ? "—" : qty(row.delta)}</td>
                <td className={row.withinTolerance ? "text-muted" : "text-loss"}>{explain(row)}</td>
                <td>{!row.withinTolerance && <AdjustRow snapshotId={snapshotId} row={row} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
};

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";

import { errorMessage } from "../lib/errors.ts";
import { sortImportFiles } from "../server/imports.ts";
import { BankStatementImport } from "./BankStatementImport.tsx";
import {
  accountsForKind,
  DROPPED_KINDS,
  groupDropped,
  KIND_LABELS,
  type Dropped,
  type DroppedKind,
} from "./drop-groups.ts";
import { SnapshotPaste } from "./SnapshotPaste.tsx";

type Account = { readonly id: number; readonly name: string; readonly kind: "brokerage" | "bank" };

const isDroppedKind = (value: string): value is DroppedKind =>
  DROPPED_KINDS.some((kind) => kind === value);

/** One drop box for any document: the server guesses what each file is and where it belongs, the owner corrects it, then the usual preview for that kind takes over. */
export const DocumentDrop = ({
  accounts,
  onBrokerFiles,
}: {
  readonly accounts: readonly Account[];
  /** Hands broker transaction files to the page's own import flow. */
  readonly onBrokerFiles: (accountId: number, files: readonly File[]) => void;
}) => {
  const [entries, setEntries] = useState<Dropped[]>([]);
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const sort = useMutation({
    mutationFn: async (files: File[]) => {
      const form = new FormData();
      for (const file of files) form.append("file", file);
      const sorted = await sortImportFiles({ data: form });
      return files.map((file, index): Dropped => {
        const answer = sorted[index];
        return {
          name: file.name,
          kind: answer?.kind ?? "unknown",
          accountId: answer?.accountId ?? null,
          reason: answer?.reason ?? "",
          file,
        };
      });
    },
    onMutate: () => {
      setError(null);
      setOpened(new Set());
    },
    onSuccess: setEntries,
    onError: (cause) => setError(errorMessage(cause, "Could not sort the files")),
  });

  const change = (index: number, patch: Partial<Pick<Dropped, "kind" | "accountId">>) => {
    setEntries((current) =>
      current.map((entry, at) => (at === index ? { ...entry, ...patch } : entry)),
    );
    setOpened(new Set());
  };

  const nameOf = (id: number | null): string =>
    accounts.find((account) => account.id === id)?.name ?? "no account";

  const groups = groupDropped(entries);
  const keyOf = (kind: DroppedKind, accountId: number | null) => `${kind}:${accountId}`;

  return (
    <section className="card mt-4">
      <h2>Drop your documents</h2>
      <label>
        Any bank or broker files (CSV, PDF, text), up to 25 at once. The account is worked out for
        you; you can change it below.
        <input
          type="file"
          accept=".csv,.pdf,.txt,text/csv,text/plain,application/pdf"
          multiple
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            setEntries([]);
            if (files.length > 0) sort.mutate(files);
          }}
        />
      </label>
      {sort.isPending && <p className="text-muted mt-2 text-sm">Sorting…</p>}
      {error && (
        <p role="alert" className="mt-2 text-loss">
          {error}
        </p>
      )}

      {entries.length > 0 && (
        <ul className="mt-3 grid gap-3">
          {entries.map((entry, index) => (
            <li key={`${index}-${entry.name}`} className="grid gap-1">
              <strong>{entry.name}</strong>
              <span className="text-muted text-sm">
                Detected: {KIND_LABELS[entry.kind]} → {nameOf(entry.accountId)}. {entry.reason}
              </span>
              <div className="flex flex-wrap gap-2">
                <select
                  aria-label={`Kind of ${entry.name}`}
                  value={entry.kind}
                  onChange={(e) => {
                    if (!isDroppedKind(e.target.value)) return;
                    const kind = e.target.value;
                    const fits = accountsForKind(kind, accounts).some(
                      (a) => a.id === entry.accountId,
                    );
                    change(index, { kind, accountId: fits ? entry.accountId : null });
                  }}
                >
                  {DROPPED_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {KIND_LABELS[kind]}
                    </option>
                  ))}
                </select>
                <select
                  aria-label={`Account for ${entry.name}`}
                  value={entry.accountId ?? ""}
                  onChange={(e) =>
                    change(index, {
                      accountId: e.target.value === "" ? null : Number(e.target.value),
                    })
                  }
                >
                  <option value="">Choose an account</option>
                  {accountsForKind(entry.kind, accounts).map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name}
                    </option>
                  ))}
                </select>
              </div>
            </li>
          ))}
        </ul>
      )}

      {groups.map((group) => {
        const key = keyOf(group.kind, group.accountId);
        if (group.accountId === null || group.kind === "unknown") return null;
        const { accountId } = group;
        const files = group.files.map((entry) => entry.file);
        return (
          <div key={key} className="mt-4 grid gap-2">
            <h3>
              {KIND_LABELS[group.kind]} · {nameOf(accountId)} ({files.length})
            </h3>
            {!opened.has(key) ? (
              <button
                type="button"
                onClick={() => {
                  if (group.kind === "broker-transactions") onBrokerFiles(accountId, files);
                  else setOpened((current) => new Set([...current, key]));
                }}
              >
                Preview
              </button>
            ) : group.kind === "bank-statement" ? (
              <BankStatementImport accountId={accountId} initialFiles={files} />
            ) : (
              files.map((file, at) => (
                <SnapshotPaste
                  key={`${at}-${file.name}`}
                  accountId={accountId}
                  initialFile={file}
                  onCreated={() => undefined}
                />
              ))
            )}
          </div>
        );
      })}
    </section>
  );
};

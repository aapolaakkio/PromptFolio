import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { errorMessage } from "../lib/errors.ts";
import { commitBankDraftImport, previewBankImport } from "../server/bank-imports.ts";
import { firstThenRest } from "./preview-order.ts";
import { eur, formatDate } from "../lib/format.ts";
import { describeImport, describeMaturity, describeReconciliation } from "./cash-view.ts";
import { bankBalanceCheck, problemToRow } from "./draft-edit.ts";
import { type Column, DraftTable } from "./DraftTable.tsx";

type BankCommitResult = Awaited<ReturnType<typeof commitBankDraftImport>>;
type BankPreview = Awaited<ReturnType<typeof previewBankImport>>;
type BankDraftRow = BankPreview["draft"]["rows"][number];

const BANK_COLUMNS: readonly Column<BankDraftRow>[] = [
  { key: "date", label: "Date", kind: "date" },
  {
    key: "type",
    label: "Type",
    kind: "select",
    options: [
      { value: "DEPOSIT", label: "Deposit" },
      { value: "WITHDRAWAL", label: "Withdrawal" },
      { value: "INTEREST", label: "Interest" },
    ],
  },
  { key: "amountEur", label: "Amount", kind: "decimal", numeric: true },
  { key: "counterparty", label: "Counterparty", kind: "text" },
  { key: "message", label: "Message", kind: "text" },
];

/** A row the reader could not parse, as a blank row the owner fills in rather than loses. */
const rowFromProblem = (problem: BankPreview["draft"]["problems"][number]): BankDraftRow => ({
  ...problemToRow(problem),
  label: "",
});

/** A bank account's statements, CSV or PDF: previewed, edited, then imported. */
export const BankStatementImport = ({
  accountId,
  initialFiles = [],
}: {
  readonly accountId: number;
  readonly initialFiles?: readonly File[];
}) => {
  const queryClient = useQueryClient();
  const [files, setFiles] = useState<File[]>([...initialFiles]);
  const [drafts, setDrafts] = useState<
    { name: string; preview: BankPreview; suggestedLines: ReadonlySet<number> }[]
  >([]);
  const [imported, setImported] = useState<{ name: string; data: BankCommitResult }[]>([]);
  const [error, setError] = useState<string | null>(null);

  // The server refuses a statement whose rows miss its closing balance; disable the button first.
  const balancesAgree = drafts.every(
    (entry) => bankBalanceCheck(entry.preview.draft)?.ok !== false,
  );

  const formFor = (file: File): FormData => {
    const form = new FormData();
    form.append("file", file);
    form.append("accountId", String(accountId));
    return form;
  };

  const preview = useMutation({
    mutationFn: () =>
      firstThenRest(files, async (file) => ({
        name: file.name,
        data: await previewBankImport({ data: formFor(file) }),
      })),
    onMutate: () => {
      setImported([]);
      setDrafts([]);
      setError(null);
    },
    // Each unparsed row becomes a blank row to fill in, so nothing is silently dropped.
    onSuccess: (results) =>
      setDrafts(
        results.map(({ name, data }) => ({
          name,
          suggestedLines: new Set(
            data.draft.problems.flatMap((problem) =>
              problem.suggestion === undefined ? [] : [problem.line],
            ),
          ),
          preview: {
            ...data,
            draft: {
              ...data.draft,
              rows: [...data.draft.rows, ...data.draft.problems.map(rowFromProblem)],
              problems: [],
            },
          },
        })),
      ),
    onError: (cause) => setError(errorMessage(cause, "Preview failed")),
  });

  // One statement at a time. A failure names the file and stops; re-importing the earlier ones
  // is a no-op (the bank's archive ids), so retrying the whole selection is safe.
  const commit = useMutation({
    mutationFn: async () => {
      for (const entry of drafts) {
        try {
          const data = await commitBankDraftImport({
            data: {
              accountId,
              filename: entry.preview.filename,
              sha256: entry.preview.sha256,
              draft: entry.preview.draft,
            },
          });
          setImported((prev) => [...prev, { name: entry.name, data }]);
        } catch (cause) {
          const message = errorMessage(cause, "Import failed");
          throw new Error(`${entry.name}: ${message}`);
        }
      }
    },
    onSuccess: () => {
      setError(null);
      preview.reset();
      setDrafts([]);
      setFiles([]);
    },
    onError: (cause) => setError(errorMessage(cause, "Import failed")),
    onSettled: () => void queryClient.invalidateQueries(),
  });

  return (
    <section className="card mt-4 grid gap-3">
      <h2>Import bank statement</h2>
      <p className="text-muted text-sm">
        The bank's transaction export (CSV) or bank statement (PDF). The same file can be imported
        again: rows already imported are skipped by the bank's archive id. The same period can be
        imported in both formats — the PDF fills in the payee details the CSV leaves blank. You can
        select several files at once, e.g. every monthly bank statement.
      </p>
      <input
        type="file"
        aria-label="Bank statements"
        accept=".csv,.pdf,text/csv,application/pdf"
        multiple
        onChange={(event) => {
          setFiles(Array.from(event.target.files ?? []));
          setImported([]);
          setDrafts([]);
          preview.reset();
        }}
      />
      <div className="flex gap-2">
        <button
          type="button"
          disabled={files.length === 0 || preview.isPending}
          onClick={() => preview.mutate()}
        >
          {preview.isPending ? "Reading…" : "Preview"}
        </button>
        <button
          type="button"
          disabled={drafts.length === 0 || commit.isPending || !balancesAgree}
          onClick={() => commit.mutate()}
        >
          {commit.isPending
            ? "Importing…"
            : drafts.length > 1
              ? `Import ${drafts.length} files`
              : "Import"}
        </button>
      </div>

      {error !== null && (
        <p role="alert" className="text-loss">
          {error}
        </p>
      )}

      {drafts.map((entry, index) => {
        const check = bankBalanceCheck(entry.preview.draft);
        return (
          <div key={`${index}-${entry.name}`} className="grid gap-2">
            {drafts.length > 1 && <h3>{entry.name}</h3>}
            {entry.preview.draft.statement !== null && (
              <p className="text-muted text-sm">
                Bank statement {formatDate(entry.preview.draft.statement.from)}–
                {formatDate(entry.preview.draft.statement.to)}, balance{" "}
                {eur(entry.preview.draft.statement.openingBalanceEur)} →{" "}
                {eur(entry.preview.draft.statement.closingBalanceEur)}. The opening balance is
                recorded automatically.
              </p>
            )}
            {check !== null && (
              <p className={check.ok ? "text-gain text-sm" : "text-loss text-sm"}>
                {check.ok
                  ? "The rows match the closing balance."
                  : `The rows do not match the closing balance: difference €${check.differenceEur}.`}
              </p>
            )}
            <DraftTable
              rows={entry.preview.draft.rows}
              columns={BANK_COLUMNS}
              isSuggested={(row) => entry.suggestedLines.has(row.line)}
              blank={(): BankDraftRow => ({
                line: entry.preview.draft.rows.length + 1,
                date: "",
                type: "DEPOSIT",
                amountEur: "",
                counterparty: "",
                label: "",
                message: "",
                externalId: null,
              })}
              onChange={(rows) =>
                setDrafts((current) =>
                  current.map((d, at) =>
                    at === index
                      ? { ...d, preview: { ...d.preview, draft: { ...d.preview.draft, rows } } }
                      : d,
                  ),
                )
              }
            />
          </div>
        );
      })}

      {imported.map(({ name, data }, index) => (
        <div key={`${index}-${name}`}>
          {imported.length > 1 && <h3>{name}</h3>}
          <p>{describeImport(data)}</p>
          {describeMaturity(data) !== null && (
            <p className={data.maturityConflict === null ? "" : "text-loss"}>
              {describeMaturity(data)}
            </p>
          )}
          {data.reconciliation && (
            <p className={data.reconciliation.differenceEur === "0.00" ? "" : "text-loss"}>
              {describeReconciliation(data.reconciliation)}
            </p>
          )}
        </div>
      ))}
    </section>
  );
};

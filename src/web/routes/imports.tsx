import { useState } from "react";
import { applyProposal } from "./corporate-action-apply.ts";
import { CorporateActionCard } from "./CorporateActionCard.tsx";
import { errorMessage } from "../lib/errors.ts";
import { getAccounts } from "../server/accounts.ts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  commitImportDraft,
  getImports,
  previewImport,
  previewOpPaste,
  undoImport,
} from "../server/imports.ts";
import { CreateAccountForm } from "./CreateAccountForm.tsx";
import { accountTypeLabel } from "./account-type.ts";
import { RenameAccount } from "./RenameAccount.tsx";
import { ImportHistory } from "./ImportHistory.tsx";
import {
  type CommitResult,
  minorToEur,
  summariseAll,
  unknownAcross,
  type DraftResponse,
  type EditableTxn,
} from "./imports-draft.ts";
import { undoConfirmMessage, type ImportRecord } from "./imports-history.ts";
import { UnknownInstrumentForm } from "./UnknownInstrumentForm.tsx";
import { BankStatementImport } from "./BankStatementImport.tsx";
import { DocumentDrop } from "./DocumentDrop.tsx";
import { type Column, DraftTable } from "./DraftTable.tsx";
import { firstThenRest } from "./preview-order.ts";
import { clearEdited, pickSuggested } from "./draft-edit.ts";
import { Modal } from "./Modal.tsx";
import { usePublishSelection } from "./assistant-context.ts";

/** Which upload path produced the previews, so resolving an unknown instrument re-previews the right one. */
type Source = "file" | "paste";

/** One previewed input: its file (none for a paste), what the server read, and the owner's edited rows. */
type Previewed = {
  readonly name: string;
  readonly file: File | null;
  readonly draft: DraftResponse;
  readonly rows: EditableTxn[];
};

const QUANTITY_SCALE = 1_000_000;
const EUR_RATE = 100_000_000;

const toEditable = (txn: DraftResponse["txns"][number]): EditableTxn => ({
  line: txn.line,
  tradeDate: txn.tradeDate,
  type: txn.type,
  isin: txn.isin ?? "",
  quantityText: (txn.quantity / QUANTITY_SCALE).toString(),
  amountEur: minorToEur(txn.amount),
  feeEur: minorToEur(txn.fee),
  currency: txn.currency,
  note: txn.note ?? "",
});

/** Back to what the commit takes. Fields the table does not show are carried over from the preview row. */
const fromEditable = (
  row: EditableTxn,
  base: DraftResponse["txns"][number] | undefined,
  accountId: number,
): DraftResponse["txns"][number] => ({
  line: row.line,
  accountId,
  instrumentId: base?.instrumentId ?? null,
  isin: row.isin === "" ? null : row.isin,
  type: row.type,
  tradeDate: row.tradeDate,
  quantity: Math.round(Number(row.quantityText.replace(",", ".")) * QUANTITY_SCALE),
  unitPrice: base?.unitPrice ?? null,
  amount: Math.round(Number(row.amountEur.replace(",", ".")) * 100),
  fee: Math.round(Number(row.feeEur.replace(",", ".")) * 100),
  tax: base?.tax ?? 0,
  currency: row.currency,
  fxRateEur: row.currency === "EUR" ? EUR_RATE : 0,
  externalId: base?.externalId ?? null,
  note: row.note === "" ? null : row.note,
  // Names an instrument added while Yahoo is paused; the commit reads it.
  instrumentName: base?.instrumentName,
});

/** A line the reader could not parse becomes a blank row carrying its text, to fill in or remove. */
const SUGGESTED_FIELDS = [
  "tradeDate",
  "type",
  "isin",
  "quantityText",
  "amountEur",
  "feeEur",
  "currency",
] as const;

const rowFromProblem = (problem: DraftResponse["problems"][number]): EditableTxn => {
  const suggested = pickSuggested(problem.suggestion, SUGGESTED_FIELDS);
  return {
    line: problem.line,
    tradeDate: "",
    type: "BUY",
    isin: "",
    quantityText: "",
    amountEur: "",
    feeEur: "0",
    currency: "EUR",
    ...suggested,
    note: problem.rawLine ?? problem.message,
    suggested: Object.keys(suggested).length > 0,
  };
};

/** A row skipped on purpose is reported, not editable: the other leg of its event carries it. */
const editableRows = (draft: DraftResponse): EditableTxn[] => [
  ...draft.txns.map(toEditable),
  ...draft.problems.filter((problem) => problem.ignored !== true).map(rowFromProblem),
];

/** Rows still missing what every transaction needs, by their source line. */
const unfinishedLines = (rows: readonly EditableTxn[]): number[] =>
  rows
    .filter((row) => !/^\d{4}-\d{2}-\d{2}$/.test(row.tradeDate) || row.amountEur.trim() === "")
    .map((row) => row.line);

/** Which import record the commit writes. */
const kindOf = (entry: Previewed): "csv" | "paste" | "pdf" => {
  if (entry.file === null) return "paste";
  return entry.draft.broker === "pdf" ? "pdf" : "csv";
};

const TXN_COLUMNS: readonly Column<EditableTxn>[] = [
  { key: "tradeDate", label: "Date", kind: "date" },
  {
    key: "type",
    label: "Type",
    kind: "select",
    options: [
      "BUY",
      "SELL",
      "DIVIDEND",
      "DEPOSIT",
      "WITHDRAWAL",
      "FEE",
      "TRANSFER_IN",
      "TRANSFER_OUT",
      "SPLIT",
      "INTEREST",
    ].map((value) => ({ value, label: value })),
  },
  { key: "isin", label: "ISIN", kind: "text" },
  { key: "quantityText", label: "Quantity", kind: "decimal", numeric: true },
  { key: "amountEur", label: "Amount", kind: "decimal", numeric: true },
  { key: "feeEur", label: "Fees", kind: "decimal", numeric: true },
  { key: "currency", label: "Currency", kind: "text" },
  { key: "note", label: "Note", kind: "text" },
];

/** What an import did, in one line. Enriched rows are named apart from skipped duplicates. */
const importSummary = (data: CommitResult): string => {
  const base = `${data.inserted} transactions imported, ${data.skipped} skipped as duplicates`;
  return data.enriched > 0 ? `${base}, ${data.enriched} enriched.` : `${base}.`;
};

export const ImportsPage = () => {
  const queryClient = useQueryClient();
  const [source, setSource] = useState<Source>("file");
  const [files, setFiles] = useState<File[]>([]);
  const [pasteText, setPasteText] = useState("");
  const [accountId, setAccountId] = useState<number | null>(null);
  const [previews, setPreviews] = useState<Previewed[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<string[]>([]);
  const [showCreateAccount, setShowCreateAccount] = useState(false);
  // The import an undo is in flight for; disables only that entry's button.
  const [undoingId, setUndoingId] = useState<number | null>(null);
  const [undoError, setUndoError] = useState<string | null>(null);
  usePublishSelection(accountId);

  const accounts = useQuery({
    queryKey: ["accounts"],
    queryFn: () => getAccounts(),
  });

  const history = useQuery({
    queryKey: ["imports"],
    queryFn: () => getImports(),
  });

  // Irreversible from the user's side, so `handleUndo` always confirms first.
  const undo = useMutation({
    mutationFn: (importId: number) => undoImport({ data: { importId } }),
    onMutate: (importId) => {
      setUndoingId(importId);
      setUndoError(null);
    },
    onSuccess: () => {
      setUndoingId(null);
      // Refetches the history and every query the removed transactions could affect.
      void queryClient.invalidateQueries();
    },
    onError: (cause) => {
      setUndoingId(null);
      // The server's 409 message says why (e.g. a later sale depends on these units); shown verbatim.
      setUndoError(errorMessage(cause, "Undo failed"));
    },
  });

  const handleUndo = (record: ImportRecord) => {
    if (!window.confirm(undoConfirmMessage(record))) return;
    undo.mutate(record.id);
  };
  const hasAccounts = (accounts.data?.length ?? 0) > 0;
  const selectedAccount = (accounts.data ?? []).find((a) => a.id === accountId);
  // With no accounts the create form shows automatically; afterwards it sits behind a toggle.
  const showCreateAccountForm = showCreateAccount || (!accounts.isPending && !hasAccounts);

  const resetOutcome = () => {
    setPreviews(null);
    setError(null);
    setResults([]);
  };

  const accountCreated = (created: { readonly id: number }) => {
    setAccountId(created.id);
    setShowCreateAccount(false);
    resetOutcome();
    void queryClient.invalidateQueries({ queryKey: ["accounts"] });
  };

  const selectSource = (next: Source) => {
    setSource(next);
    resetOutcome();
  };

  const fileForm = (file: File): FormData => {
    const data = new FormData();
    data.set("file", file);
    // SAFETY: the "Preview" button is disabled while `accountId` is null.
    data.set("accountId", String(accountId));
    return data;
  };

  const showPreviews = (data: Previewed[]) => {
    setPreviews(data);
    setError(null);
    setResults([]);
  };

  const previewFile = useMutation({
    mutationFn: () =>
      firstThenRest(files, async (file) => {
        const draft = await previewImport({ data: fileForm(file) });
        return { name: file.name, file, draft, rows: editableRows(draft) };
      }),
    onSuccess: showPreviews,
    onError: (cause) => setError(errorMessage(cause, "Preview failed")),
  });

  // The pasted text is sent untouched, never trimmed or collapsed: a recipe reads tabs,
  // separator lines and unit padding ("1,0453   kpl") as structure.
  const pasteBody = () => ({
    // SAFETY: same as fileForm -- the paste buttons are disabled whenever
    // `pasteText` is empty or `accountId` is null.
    accountId: accountId!,
    text: pasteText,
  });

  const previewPaste = useMutation({
    mutationFn: async () => {
      const draft = await previewOpPaste({ data: pasteBody() });
      return [{ name: "Pasted text", file: null, draft, rows: editableRows(draft) }];
    },
    onSuccess: showPreviews,
    onError: (cause) => setError(errorMessage(cause, "Preview failed")),
  });

  // One input at a time, so each file is its own import with its own undo. A failure stops
  // the loop: earlier files are in, the failing one is named, the rest stay for a retry.
  const commit = useMutation({
    mutationFn: async () => {
      for (const entry of previews ?? []) {
        try {
          const data = await commitImportDraft({
            data: {
              // SAFETY: the commit button is disabled while no account is chosen.
              accountId: accountId ?? 0,
              filename: entry.draft.filename,
              sha256: entry.draft.sha256,
              kind: kindOf(entry),
              draft: {
                txns: entry.rows.map((row, index) =>
                  fromEditable(row, entry.draft.txns[index], accountId ?? 0),
                ),
                problems: [],
                unknownIsins: entry.draft.unknownIsins,
              },
            },
          });
          setResults((prev) => [...prev, `${entry.name}: ${importSummary(data)}`]);
          setPreviews((prev) => prev?.filter((p) => p !== entry) ?? null);
          setFiles((prev) => prev.filter((f) => f !== entry.file));
        } catch (cause) {
          const message = errorMessage(cause, "Import failed");
          throw new Error(`${entry.name}: ${message}`);
        }
      }
    },
    onSuccess: () => {
      setPreviews(null);
      setError(null);
    },
    onError: (cause) => setError(errorMessage(cause, "Import failed")),
    onSettled: () => void queryClient.invalidateQueries(),
  });

  const preview = source === "file" ? previewFile : previewPaste;

  const drafts = (previews ?? []).map((p) => p.draft);
  const unknown = unknownAcross(drafts);
  // The rows on screen are what will be imported, so the count and can-commit rule read them.
  const editedRows = (previews ?? []).reduce((sum, entry) => sum + entry.rows.length, 0);
  const unfinished = (previews ?? []).flatMap((entry) => unfinishedLines(entry.rows));
  const summary =
    previews === null
      ? null
      : {
          ...summariseAll(drafts),
          good: editedRows,
          problems: 0,
          canCommit:
            previews.length > 0 &&
            editedRows > 0 &&
            unknown.length === 0 &&
            unfinished.length === 0,
        };

  const setRows = (index: number, rows: EditableTxn[]) =>
    setPreviews(
      (current) =>
        current?.map((entry, at) =>
          at === index ? { ...entry, rows: clearEdited(entry.rows, rows) } : entry,
        ) ?? null,
    );

  // Applied proposals stay marked as suggestions, unlike the owner's own edits.
  const setAppliedRows = (index: number, rows: EditableTxn[]) =>
    setPreviews(
      (current) => current?.map((entry, at) => (at === index ? { ...entry, rows } : entry)) ?? null,
    );

  // Broker files sorted by the drop box go through this page's own flow below.
  const takeBrokerFiles = (id: number, dropped: readonly File[]) => {
    setSource("file");
    setAccountId(id);
    setFiles([...dropped]);
    resetOutcome();
  };

  return (
    <>
      <h1>Imports</h1>

      {hasAccounts && (
        <DocumentDrop accounts={accounts.data ?? []} onBrokerFiles={takeBrokerFiles} />
      )}

      <section className="card mt-4">
        <label>
          Account
          <select
            value={accountId ?? ""}
            onChange={(e) => {
              setAccountId(Number(e.target.value));
              resetOutcome();
            }}
          >
            <option value="" disabled>
              Choose an account
            </option>
            {(accounts.data ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>

        {hasAccounts && (
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="mt-3 text-sm"
              onClick={() => setShowCreateAccount(true)}
            >
              + New account
            </button>
            {selectedAccount && (
              <span className="mt-3 text-sm text-muted">
                {accountTypeLabel(selectedAccount.accountType)}
              </span>
            )}
            {selectedAccount && (
              <RenameAccount
                accountId={selectedAccount.id}
                currentName={selectedAccount.name}
                currentType={selectedAccount.accountType}
                kind={selectedAccount.kind}
              />
            )}
          </div>
        )}
        {!accounts.isPending && !hasAccounts && (
          <p className="mt-3 text-sm text-muted">
            No accounts yet. Create your first account below to start importing.
          </p>
        )}
        {/* The very first account's form is the page's main content; later ones open over it. */}
        {showCreateAccountForm &&
          (hasAccounts ? (
            <Modal title="New account" onClose={() => setShowCreateAccount(false)}>
              <CreateAccountForm onCreated={accountCreated} />
            </Modal>
          ) : (
            <CreateAccountForm onCreated={accountCreated} />
          ))}
      </section>

      {selectedAccount?.kind === "bank" ? (
        // Choosing a bank account switches this page to the bank statement import.
        <BankStatementImport key={selectedAccount.id} accountId={selectedAccount.id} />
      ) : (
        <>
          <div className="mt-4 flex gap-2">
            <button type="button" disabled={source === "file"} onClick={() => selectSource("file")}>
              CSV file
            </button>
            <button
              type="button"
              disabled={source === "paste"}
              onClick={() => selectSource("paste")}
            >
              Paste text
            </button>
          </div>

          {source === "file" ? (
            <section className="card mt-4">
              <label>
                Broker CSV or PDF files (Nordnet, OP, other brokers). You can select several files
                at once.
                <input
                  type="file"
                  accept=".csv,.pdf,text/csv,application/pdf"
                  multiple
                  onChange={(e) => {
                    setFiles(Array.from(e.target.files ?? []));
                    resetOutcome();
                  }}
                />
              </label>
              <button
                type="button"
                disabled={files.length === 0 || accountId === null || previewFile.isPending}
                onClick={() => previewFile.mutate()}
              >
                {previewFile.isPending ? "Reading…" : "Preview"}
              </button>
            </section>
          ) : (
            <section className="card mt-4">
              <label>
                The transaction table from the broker's website (copy and paste it as is)
                <textarea
                  rows={10}
                  className="font-mono text-xs"
                  value={pasteText}
                  onChange={(e) => {
                    setPasteText(e.target.value);
                    resetOutcome();
                  }}
                />
              </label>
              <button
                type="button"
                disabled={pasteText === "" || accountId === null || previewPaste.isPending}
                onClick={() => previewPaste.mutate()}
              >
                {previewPaste.isPending ? "Reading…" : "Preview"}
              </button>
            </section>
          )}

          {error && (
            <p role="alert" className="mt-4 text-loss">
              {error}
            </p>
          )}
          {results.length > 0 && (
            <ul role="status" className="mt-4 grid gap-1 text-gain">
              {results.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}

          {previews && summary && (
            <>
              {previews.map((entry, index) => (
                <PreviewCard
                  key={`${index}-${entry.name}`}
                  entry={entry}
                  unknownCount={unknown.length}
                  onRows={(rows) => setRows(index, rows)}
                  onApplied={(rows) => setAppliedRows(index, rows)}
                />
              ))}

              {unknown.length > 0 && (
                <section className="mt-4">
                  <h2>Unknown instruments</h2>
                  <p className="text-muted">
                    Add these before importing, so prices are fetched from the right source.
                  </p>
                  <div className="mt-3 grid gap-4 md:grid-cols-2">
                    {unknown.map((u) => (
                      <UnknownInstrumentForm
                        key={u.isin ?? u.name}
                        isin={u.isin}
                        name={u.name}
                        rowCurrency={u.currency}
                        onResolved={() => preview.mutate()}
                      />
                    ))}
                  </div>
                </section>
              )}

              {unfinished.length > 0 && (
                <p role="alert" className="mt-6 text-loss">
                  {unfinished.length === 1 ? "Row" : "Rows"} {unfinished.join(", ")}: date or amount
                  is missing. Complete or remove them before importing.
                </p>
              )}

              <button
                type="button"
                className="primary-button mt-6"
                disabled={!summary.canCommit || commit.isPending}
                onClick={() => commit.mutate()}
              >
                {commit.isPending
                  ? "Importing…"
                  : previews.length > 1
                    ? `Import ${previews.length} files (${summary.good} transactions)`
                    : `Import ${summary.good} transactions`}
              </button>
            </>
          )}
        </>
      )}

      <section className="card mt-6">
        <h2>Import history</h2>
        {undoError && (
          <p role="alert" className="mt-2 text-loss">
            {undoError}
          </p>
        )}
        {history.isError ? (
          <p role="alert" className="text-loss">
            Could not load the import history. Try refreshing the page.
          </p>
        ) : history.isPending ? (
          <p>Loading…</p>
        ) : (
          <ImportHistory records={history.data} undoingId={undoingId} onUndo={handleUndo} />
        )}
      </section>
    </>
  );
};

/** One file's preview: every row, editable, before any of it enters the ledger. */
const PreviewCard = ({
  entry,
  unknownCount,
  onRows,
  onApplied,
}: {
  readonly entry: Previewed;
  readonly unknownCount: number;
  readonly onRows: (rows: EditableTxn[]) => void;
  readonly onApplied: (rows: EditableTxn[]) => void;
}) => {
  // Proposals applied or ignored, by position; either way the card goes.
  const [settled, setSettled] = useState<readonly number[]>([]);
  const settle = (at: number) => setSettled((done) => [...done, at]);
  const noteOf = (line: number): string => {
    const problem = entry.draft.problems.find((p) => p.line === line);
    return problem?.rawLine ?? problem?.message ?? "";
  };
  return (
    <section className="card mt-6">
      <h2>
        Preview — {entry.name} ({entry.draft.broker})
      </h2>
      <p>
        {entry.rows.length} rows to import
        {unknownCount > 0 && `, ${unknownCount} unknown instruments`}. Correct the rows if needed
        before importing.
      </p>
      {entry.draft.added.length > 0 && (
        <ul className="text-sm">
          {entry.draft.added.map((added) => (
            <li key={added.isin}>
              Adding: {added.name} — {added.sourceKey ?? "looking up ticker"} · {added.currency}
            </li>
          ))}
        </ul>
      )}
      {entry.draft.problems.some((problem) => problem.ignored === true) && (
        <ul className="text-muted text-sm">
          {entry.draft.problems
            .filter((problem) => problem.ignored === true)
            .map((problem) => (
              <li key={problem.line}>
                Skipped row {problem.line}: {problem.message}
              </li>
            ))}
        </ul>
      )}

      {(entry.draft.corporateActions ?? []).map((proposal, at) =>
        settled.includes(at) ? null : (
          <CorporateActionCard
            key={proposal.lines.join("-")}
            proposal={proposal}
            onApply={() => {
              onApplied(applyProposal(entry.rows, proposal, noteOf));
              settle(at);
            }}
            onIgnore={() => settle(at)}
          />
        ),
      )}

      {/* Every row, never a cut-off list: this is the last screen before rows enter the ledger. */}
      <DraftTable
        rows={entry.rows}
        columns={TXN_COLUMNS}
        onChange={onRows}
        isSuggested={(row) => row.suggested === true}
        blank={(): EditableTxn => ({
          line: entry.rows.length + 1,
          tradeDate: "",
          type: "BUY",
          isin: "",
          quantityText: "",
          amountEur: "",
          feeEur: "0",
          currency: "EUR",
          note: "",
        })}
      />
    </section>
  );
};

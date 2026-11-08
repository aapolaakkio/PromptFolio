import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { commitBankDraftImport, previewBankImport } from "../server/bank-imports.ts";
import { eur, fiDate } from "../lib/format.ts";
import { describeImport, describeMaturity, describeReconciliation } from "./cash-view.ts";
import { bankBalanceCheck, problemToRow } from "./draft-edit.ts";
import { type Column, DraftTable } from "./DraftTable.tsx";

type BankCommitResult = Awaited<ReturnType<typeof commitBankDraftImport>>;
type BankPreview = Awaited<ReturnType<typeof previewBankImport>>;
type BankDraftRow = BankPreview["draft"]["rows"][number];

const BANK_COLUMNS: readonly Column<BankDraftRow>[] = [
  { key: "date", label: "Päivä", kind: "date" },
  {
    key: "type",
    label: "Laji",
    kind: "select",
    options: [
      { value: "DEPOSIT", label: "Pano" },
      { value: "WITHDRAWAL", label: "Otto" },
      { value: "INTEREST", label: "Korko" },
    ],
  },
  { key: "amountEur", label: "Summa", kind: "decimal", numeric: true },
  { key: "counterparty", label: "Vastapuoli", kind: "text" },
  { key: "message", label: "Viesti", kind: "text" },
];

/**
 * A row the reader could not make sense of, as a blank row carrying the
 * printed text, so the owner fills it in rather than losing it.
 */
const rowFromProblem = (problem: {
  readonly line: number;
  readonly text: string;
}): BankDraftRow => ({
  ...problemToRow(problem),
  label: "",
});

/** A bank account's statements, CSV or PDF: previewed, edited, then imported. */
export const BankStatementImport = ({ accountId }: { readonly accountId: number }) => {
  const queryClient = useQueryClient();
  const [files, setFiles] = useState<File[]>([]);
  const [drafts, setDrafts] = useState<{ name: string; preview: BankPreview }[]>([]);
  const [imported, setImported] = useState<{ name: string; data: BankCommitResult }[]>([]);
  const [error, setError] = useState<string | null>(null);

  // A statement whose rows no longer reach its own closing balance would be
  // refused by the server; the button says so before the round trip.
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
      Promise.all(
        files.map(async (file) => ({
          name: file.name,
          data: await previewBankImport({ data: formFor(file) }),
        })),
      ),
    onMutate: () => {
      setImported([]);
      setDrafts([]);
      setError(null);
    },
    // Every problem the reader reported becomes a blank row to fill in, so the
    // preview holds the whole statement and nothing is silently dropped.
    onSuccess: (results) =>
      setDrafts(
        results.map(({ name, data }) => ({
          name,
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
    onError: (cause) => setError(cause instanceof Error ? cause.message : "Esikatselu epäonnistui"),
  });

  // One statement at a time. A failure names the file and stops; the ones
  // before it are in, and re-importing them is a no-op the bank's archive
  // ids guarantee, so a retry of the whole selection is safe.
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
          const message = cause instanceof Error ? cause.message : "Tuonti epäonnistui";
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
    onError: (cause) => setError(cause instanceof Error ? cause.message : "Tuonti epäonnistui"),
    onSettled: () => void queryClient.invalidateQueries(),
  });

  return (
    <section className="card mt-4 grid gap-3">
      <h2>Tuo tiliote</h2>
      <p className="text-muted text-sm">
        Pankin tapahtumavienti (CSV) tai tiliote (PDF). Sama tiedosto voidaan tuoda uudelleen: jo
        tuodut rivit ohitetaan pankin arkistointitunnuksen perusteella. Saman jakson voi tuoda
        molemmissa muodoissa — PDF täydentää saajatiedot, jotka CSV jättää tyhjiksi.
      </p>
      <input
        type="file"
        aria-label="Tiliotteet"
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
          {preview.isPending ? "Luetaan…" : "Esikatsele"}
        </button>
        <button
          type="button"
          disabled={drafts.length === 0 || commit.isPending || !balancesAgree}
          onClick={() => commit.mutate()}
        >
          {commit.isPending
            ? "Tuodaan…"
            : drafts.length > 1
              ? `Tuo ${drafts.length} tiedostoa`
              : "Tuo"}
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
                Tiliote {fiDate(entry.preview.draft.statement.from)}–
                {fiDate(entry.preview.draft.statement.to)}, saldo{" "}
                {eur(entry.preview.draft.statement.openingBalanceEur)} →{" "}
                {eur(entry.preview.draft.statement.closingBalanceEur)}. Alkusaldo kirjataan
                automaattisesti.
              </p>
            )}
            {check !== null && (
              <p className={check.ok ? "text-gain text-sm" : "text-loss text-sm"}>
                {check.ok
                  ? "Rivit täsmäävät loppusaldoon."
                  : `Rivit eivät täsmää loppusaldoon: ero ${check.differenceEur} €.`}
              </p>
            )}
            <DraftTable
              rows={entry.preview.draft.rows}
              columns={BANK_COLUMNS}
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

import { useState } from "react";
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
} from "./imports-draft.ts";
import { undoConfirmMessage, type ImportRecord } from "./imports-history.ts";
import { UnknownInstrumentForm } from "./UnknownInstrumentForm.tsx";
import { BankStatementImport } from "./BankStatementImport.tsx";
import { type Column, DraftTable } from "./DraftTable.tsx";

/** Which upload path produced the previews, so resolving an unknown instrument re-previews the right one. */
type Source = "file" | "paste";

/**
 * One previewed input: the file it came from (none for the paste), what the
 * server read from it, and the rows as the owner has since edited them.
 */
type Previewed = {
  readonly name: string;
  readonly file: File | null;
  readonly draft: DraftResponse;
  readonly rows: EditableTxn[];
};

/** A draft row as the table edits it: money and quantity as decimal strings. */
type EditableTxn = {
  readonly line: number;
  readonly tradeDate: string;
  readonly type: string;
  readonly isin: string;
  readonly quantityText: string;
  readonly amountEur: string;
  readonly feeEur: string;
  readonly currency: string;
  readonly note: string;
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

/**
 * Back to what the commit takes. Fields the table does not show (the resolved
 * instrument, the unit price, tax, the broker's own id) are carried from the
 * row the preview produced, so editing a summary column never drops them.
 */
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
});

/**
 * A line the reader could not turn into fields becomes a blank row carrying
 * its text, so the owner fills it in or removes it rather than losing it.
 */
const rowFromProblem = (problem: DraftResponse["problems"][number]): EditableTxn => ({
  line: problem.line,
  tradeDate: "",
  type: "BUY",
  isin: "",
  quantityText: "",
  amountEur: "",
  feeEur: "0",
  currency: "EUR",
  note: problem.rawLine ?? problem.message,
});

/**
 * A row skipped on purpose is reported, not offered for editing: the other leg
 * of its event already carries it, and filling it in would book it twice.
 */
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
  { key: "tradeDate", label: "Päivä", kind: "date" },
  {
    key: "type",
    label: "Laji",
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
      "INTEREST",
    ].map((value) => ({ value, label: value })),
  },
  { key: "isin", label: "ISIN", kind: "text" },
  { key: "quantityText", label: "Määrä", kind: "decimal", numeric: true },
  { key: "amountEur", label: "Summa", kind: "decimal", numeric: true },
  { key: "feeEur", label: "Kulut", kind: "decimal", numeric: true },
  { key: "currency", label: "Valuutta", kind: "text" },
  { key: "note", label: "Selite", kind: "text" },
];

/**
 * What an import did, in one line.
 *
 * Enriched rows are named separately from skipped ones: a re-import that filled
 * in a field the ledger was missing did something, and reporting it as "ohitettu
 * kaksoiskappaleena" would tell the owner nothing happened when something did.
 */
const importSummary = (data: CommitResult): string => {
  const base = `${data.inserted} tapahtumaa tuotu, ${data.skipped} ohitettu kaksoiskappaleena`;
  return data.enriched > 0 ? `${base}, ${data.enriched} täydennetty.` : `${base}.`;
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
  // Which import an undo request is currently in flight for -- disables that one
  // entry's button (see ImportHistory's own `undoingId` prop) without disabling the
  // rest of the table.
  const [undoingId, setUndoingId] = useState<number | null>(null);
  const [undoError, setUndoError] = useState<string | null>(null);

  const accounts = useQuery({
    queryKey: ["accounts"],
    queryFn: () => getAccounts(),
  });

  const history = useQuery({
    queryKey: ["imports"],
    queryFn: () => getImports(),
  });

  // Undo is destructive and irreversible from the user's own point of view (the
  // ledger itself stays append-only server-side, but there is no UI path back to
  // these exact rows once removed) -- `handleUndo` below always confirms with the
  // user, stating plainly how many transactions will be removed
  // (`undoConfirmMessage`), before this mutation ever runs.
  const undo = useMutation({
    mutationFn: (importId: number) => undoImport({ data: { importId } }),
    onMutate: (importId) => {
      setUndoingId(importId);
      setUndoError(null);
    },
    onSuccess: () => {
      setUndoingId(null);
      // Refetches both the history (so the entry now shows "peruttu") and every
      // holdings/allocation/returns query the removed transactions could have
      // affected -- the same broad invalidation commit already does below.
      void queryClient.invalidateQueries();
    },
    onError: (cause) => {
      setUndoingId(null);
      // The server's own 409 message already names exactly why (a later sale
      // depends on the units this import introduced, per commit.ts's undoImport) --
      // shown verbatim rather than folded into a generic failure message.
      setUndoError(cause instanceof Error ? cause.message : "Perumine epäonnistui");
    },
  });

  const handleUndo = (record: ImportRecord) => {
    if (!window.confirm(undoConfirmMessage(record))) return;
    undo.mutate(record.id);
  };
  const hasAccounts = (accounts.data?.length ?? 0) > 0;
  const selectedAccount = (accounts.data ?? []).find((a) => a.id === accountId);
  // A brand-new install has zero accounts and, per spec §10 item 3, no way
  // to reach account creation except `curl` -- the gap this form closes.
  // The create form shows automatically once accounts have loaded and there
  // are none, so a first-time user finds it without documentation; once at
  // least one account exists, it stays tucked behind a toggle instead of
  // permanently occupying screen space on every later visit.
  const showCreateAccountForm = showCreateAccount || (!accounts.isPending && !hasAccounts);

  const resetOutcome = () => {
    setPreviews(null);
    setError(null);
    setResults([]);
  };

  const selectSource = (next: Source) => {
    setSource(next);
    resetOutcome();
  };

  const fileForm = (file: File): FormData => {
    const data = new FormData();
    data.set("file", file);
    // SAFETY: the "Esikatsele" button below is disabled while `accountId` is
    // null, so it is always set by the time a preview or commit runs.
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
      Promise.all(
        files.map(async (file) => {
          const draft = await previewImport({ data: fileForm(file) });
          return { name: file.name, file, draft, rows: editableRows(draft) };
        }),
      ),
    onSuccess: showPreviews,
    onError: (cause) => setError(cause instanceof Error ? cause.message : "Esikatselu epäonnistui"),
  });

  // The pasted text travels from the <textarea> to this body untouched --
  // never trimmed or whitespace-collapsed. A recipe reads tabs, separator
  // lines and unit padding ("1,0453   kpl") as structure, so normalising any
  // of them would change the layout it was written for.
  const pasteBody = () => ({
    // SAFETY: same as fileForm -- the paste buttons are disabled whenever
    // `pasteText` is empty or `accountId` is null.
    accountId: accountId!,
    text: pasteText,
  });

  const previewPaste = useMutation({
    mutationFn: async () => {
      const draft = await previewOpPaste({ data: pasteBody() });
      return [{ name: "Liite", file: null, draft, rows: editableRows(draft) }];
    },
    onSuccess: showPreviews,
    onError: (cause) => setError(cause instanceof Error ? cause.message : "Esikatselu epäonnistui"),
  });

  // One input at a time, so each file stays its own import with its own undo.
  // A failure stops the loop: the files before it are in, the failing one is
  // named, and the rest stay in the preview for a retry.
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
          const message = cause instanceof Error ? cause.message : "Tuonti epäonnistui";
          throw new Error(`${entry.name}: ${message}`);
        }
      }
    },
    onSuccess: () => {
      setPreviews(null);
      setError(null);
    },
    onError: (cause) => setError(cause instanceof Error ? cause.message : "Tuonti epäonnistui"),
    onSettled: () => void queryClient.invalidateQueries(),
  });

  const preview = source === "file" ? previewFile : previewPaste;

  const drafts = (previews ?? []).map((p) => p.draft);
  const unknown = unknownAcross(drafts);
  // The rows on screen are what will be imported, so the count and the
  // can-commit rule read them rather than the draft the server first sent.
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
      (current) => current?.map((entry, at) => (at === index ? { ...entry, rows } : entry)) ?? null,
    );

  return (
    <>
      <h1>Tuonnit</h1>

      <section className="card">
        <label>
          Tili
          <select
            value={accountId ?? ""}
            onChange={(e) => {
              setAccountId(Number(e.target.value));
              resetOutcome();
            }}
          >
            <option value="" disabled>
              Valitse tili
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
              onClick={() => setShowCreateAccount((v) => !v)}
            >
              {showCreateAccount ? "Peruuta" : "+ Uusi tili"}
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
            Ei vielä tilejä. Luo ensimmäinen tili alle aloittaaksesi tuonnin.
          </p>
        )}
        {showCreateAccountForm && (
          <CreateAccountForm
            onCreated={(created) => {
              setAccountId(created.id);
              setShowCreateAccount(false);
              resetOutcome();
              void queryClient.invalidateQueries({ queryKey: ["accounts"] });
            }}
          />
        )}
      </section>

      {selectedAccount?.kind === "bank" ? (
        // Statements go onto bank accounts and nowhere else, so choosing one
        // switches this page to the statement import.
        <BankStatementImport key={selectedAccount.id} accountId={selectedAccount.id} />
      ) : (
        <>
          <div className="mt-4 flex gap-2">
            <button type="button" disabled={source === "file"} onClick={() => selectSource("file")}>
              CSV-tiedosto
            </button>
            <button
              type="button"
              disabled={source === "paste"}
              onClick={() => selectSource("paste")}
            >
              Liitä teksti
            </button>
          </div>

          {source === "file" ? (
            <section className="card mt-4">
              <label>
                Välittäjän CSV- tai PDF-tiedostot (Nordnet, OP, muut välittäjät)
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
                {previewFile.isPending ? "Luetaan…" : "Esikatsele"}
              </button>
            </section>
          ) : (
            <section className="card mt-4">
              <label>
                Välittäjän verkkopalvelun tapahtumataulukko (kopioi ja liitä sellaisenaan)
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
                {previewPaste.isPending ? "Luetaan…" : "Esikatsele"}
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
                />
              ))}

              {unknown.length > 0 && (
                <section className="mt-4">
                  <h2>Tuntemattomat arvopaperit</h2>
                  <p className="text-muted">
                    Lisää nämä ennen tuontia, jotta hinnat osataan hakea oikeasta lähteestä.
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
                  {unfinished.length === 1 ? "Rivi" : "Rivit"} {unfinished.join(", ")}: päivä tai
                  summa puuttuu. Täydennä tai poista ne ennen tuontia.
                </p>
              )}

              <button
                type="button"
                className="mt-6"
                disabled={!summary.canCommit || commit.isPending}
                onClick={() => commit.mutate()}
              >
                {commit.isPending
                  ? "Tuodaan…"
                  : previews.length > 1
                    ? `Tuo ${previews.length} tiedostoa (${summary.good} tapahtumaa)`
                    : `Tuo ${summary.good} tapahtumaa`}
              </button>
            </>
          )}
        </>
      )}

      <section className="card mt-6">
        <h2>Tuontihistoria</h2>
        {undoError && (
          <p role="alert" className="mt-2 text-loss">
            {undoError}
          </p>
        )}
        {history.isError ? (
          <p role="alert" className="text-loss">
            Tuontihistorian haku epäonnistui. Yritä päivittää sivu.
          </p>
        ) : history.isPending ? (
          <p>Ladataan…</p>
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
}: {
  readonly entry: Previewed;
  readonly unknownCount: number;
  readonly onRows: (rows: EditableTxn[]) => void;
}) => (
  <section className="card mt-6">
    <h2>
      Esikatselu — {entry.name} ({entry.draft.broker})
    </h2>
    <p>
      {entry.rows.length} tuotavaa riviä
      {unknownCount > 0 && `, ${unknownCount} tuntematonta arvopaperia`}. Korjaa rivit tarvittaessa
      ennen tuontia.
    </p>
    {entry.draft.problems.some((problem) => problem.ignored === true) && (
      <ul className="text-muted text-sm">
        {entry.draft.problems
          .filter((problem) => problem.ignored === true)
          .map((problem) => (
            <li key={problem.line}>
              Ohitettu rivi {problem.line}: {problem.message}
            </li>
          ))}
      </ul>
    )}

    {/*
        Every row, editable and scrollable, rather than the first 50 and a count
        of what was hidden: this is the last screen before the rows enter the
        ledger, so the rows a reviewer most needs to check are exactly the ones a
        cut-off list hides. Lines the reader could not parse are here too, as
        blank rows carrying their text.
      */}
    <DraftTable
      rows={entry.rows}
      columns={TXN_COLUMNS}
      onChange={onRows}
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

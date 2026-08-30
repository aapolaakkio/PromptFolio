import { useState } from "react";
import { getAccounts } from "../server/accounts.ts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../lib/api.ts";
import {
  commitImport,
  commitOpPaste,
  getImports,
  previewImport,
  previewOpPaste,
  undoImport,
} from "../server/imports.ts";
import { eur, fiDate } from "../lib/format.ts";
import { CreateAccountForm } from "./CreateAccountForm.tsx";
import { accountTypeLabel } from "./account-type.ts";
import { RenameAccount } from "./RenameAccount.tsx";
import { ImportHistory } from "./ImportHistory.tsx";
import { type CommitResult, minorToEur, summarise, type DraftResponse } from "./imports-draft.ts";
import { undoConfirmMessage, type ImportRecord } from "./imports-history.ts";
import { UnknownInstrumentForm } from "./UnknownInstrumentForm.tsx";

/** Which upload path produced the current `draft`, so resolving an unknown instrument re-previews the right one. */
type Source = "file" | "paste";

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
  const [file, setFile] = useState<File | null>(null);
  const [pasteText, setPasteText] = useState("");
  const [accountId, setAccountId] = useState<number | null>(null);
  const [draft, setDraft] = useState<DraftResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
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
      setUndoError(cause instanceof ApiError ? cause.message : "Perumine epäonnistui");
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
    setDraft(null);
    setError(null);
    setResult(null);
  };

  const selectSource = (next: Source) => {
    setSource(next);
    resetOutcome();
  };

  const fileForm = (): FormData => {
    const data = new FormData();
    // SAFETY: the "Esikatsele"/"Tuo" buttons below are disabled whenever
    // `file` or `accountId` is null, so both are always set by the time
    // either mutation actually runs.
    data.set("file", file!);
    data.set("accountId", String(accountId));
    return data;
  };

  const previewFile = useMutation({
    mutationFn: () => previewImport({ data: fileForm() }),
    onSuccess: (data) => {
      setDraft(data);
      setError(null);
      setResult(null);
    },
    onError: (cause) =>
      setError(cause instanceof ApiError ? cause.message : "Esikatselu epäonnistui"),
  });

  const commitFile = useMutation({
    mutationFn: () => commitImport({ data: fileForm() }),
    onSuccess: (data) => {
      setResult(importSummary(data));
      setDraft(null);
      void queryClient.invalidateQueries();
    },
    onError: (cause) => setError(cause instanceof ApiError ? cause.message : "Tuonti epäonnistui"),
  });

  // The OP paste text travels from the <textarea> to this body untouched --
  // never trimmed or whitespace-collapsed. The parser anchors on an exact
  // single-space separator line and multi-space unit padding
  // ("1,0453   kpl"); either would destroy that shape (spec §10a A3,
  // op-paste.ts's own module comment).
  const pasteBody = () => ({
    // SAFETY: same as fileForm -- the paste buttons are disabled whenever
    // `pasteText` is empty or `accountId` is null.
    accountId: accountId!,
    text: pasteText,
  });

  const previewPaste = useMutation({
    mutationFn: () => previewOpPaste({ data: pasteBody() }),
    onSuccess: (data) => {
      setDraft(data);
      setError(null);
      setResult(null);
    },
    onError: (cause) =>
      setError(cause instanceof ApiError ? cause.message : "Esikatselu epäonnistui"),
  });

  const commitPaste = useMutation({
    mutationFn: () => commitOpPaste({ data: pasteBody() }),
    onSuccess: (data) => {
      setResult(importSummary(data));
      setDraft(null);
      void queryClient.invalidateQueries();
    },
    onError: (cause) => setError(cause instanceof ApiError ? cause.message : "Tuonti epäonnistui"),
  });

  const preview = source === "file" ? previewFile : previewPaste;
  const commit = source === "file" ? commitFile : commitPaste;

  const summary = draft ? summarise(draft) : null;

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

      <div className="mt-4 flex gap-2">
        <button type="button" disabled={source === "file"} onClick={() => selectSource("file")}>
          CSV-tiedosto
        </button>
        <button type="button" disabled={source === "paste"} onClick={() => selectSource("paste")}>
          OP-liite (liitä teksti)
        </button>
      </div>

      {source === "file" ? (
        <section className="card mt-4">
          <label>
            CSV-tiedosto (Nordnet)
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                resetOutcome();
              }}
            />
          </label>
          <button
            type="button"
            disabled={!file || accountId === null || previewFile.isPending}
            onClick={() => previewFile.mutate()}
          >
            {previewFile.isPending ? "Luetaan…" : "Esikatsele"}
          </button>
        </section>
      ) : (
        <section className="card mt-4">
          <label>
            OP:n verkkopalvelun tapahtumataulukko (kopioi ja liitä sellaisenaan)
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
      {result && (
        <p role="status" className="mt-4 text-gain">
          {result}
        </p>
      )}

      {draft && summary && (
        <>
          <section className="card mt-6">
            <h2>Esikatselu — {draft.broker}</h2>
            <p>
              {summary.good} tuotavaa riviä
              {summary.problems > 0 && `, ${summary.problems} ongelmaa`}
              {summary.unknown > 0 && `, ${summary.unknown} tuntematonta arvopaperia`}.
            </p>

            {/*
              Every row, scrollable, rather than the first 50 and a count of
              what was hidden: this is the last screen before the rows enter the
              ledger, so the rows a reviewer most needs to check are exactly the
              ones a cut-off list hides. The header stays put while the body
              scrolls.
            */}
            <div className="max-h-[28rem] overflow-auto rounded border border-line">
              <table>
                <thead className="sticky top-0 bg-surface">
                  <tr>
                    <th>Rivi</th>
                    <th>Päivä</th>
                    <th>Laji</th>
                    <th>ISIN</th>
                    <th className="num">Summa</th>
                  </tr>
                </thead>
                <tbody>
                  {draft.txns.map((t) => (
                    <tr key={t.line}>
                      <td className="num">{t.line}</td>
                      <td>{fiDate(t.tradeDate)}</td>
                      <td>{t.type}</td>
                      <td>{t.isin ?? "—"}</td>
                      <td className="num">{eur(minorToEur(t.amount))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {draft.problems.length > 0 && (
            <section className="card mt-4">
              <h2>Ongelmalliset rivit</h2>
              <p className="text-muted">
                Näitä rivejä ei tuoda. Korjaa tiedosto tai jatka ilman niitä.
              </p>
              <ul className="mt-3 grid gap-2">
                {draft.problems.map((p) => (
                  <li key={p.line}>
                    <strong>Rivi {p.line}:</strong> {p.message}
                    <div className="font-mono text-xs text-muted">
                      {p.rawLine !== undefined
                        ? p.rawLine
                        : Object.entries(p.raw)
                            .map(([k, v]) => `${k}=${v}`)
                            .join("  ")}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {draft.unknownIsins.length > 0 && (
            <section className="mt-4">
              <h2>Tuntemattomat arvopaperit</h2>
              <p className="text-muted">
                Lisää nämä ennen tuontia, jotta hinnat osataan hakea oikeasta lähteestä.
              </p>
              <div className="mt-3 grid gap-4 md:grid-cols-2">
                {draft.unknownIsins.map((u) => (
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

          <button
            type="button"
            className="mt-6"
            disabled={!summary.canCommit || commit.isPending}
            onClick={() => commit.mutate()}
          >
            {commit.isPending ? "Tuodaan…" : `Tuo ${summary.good} tapahtumaa`}
          </button>
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

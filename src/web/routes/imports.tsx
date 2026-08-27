import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiGet, apiPost, apiUpload } from "../lib/api";
import { eur, fiDate } from "../lib/format";
import {
  AccountsSchema,
  CommitResultSchema,
  DraftResponseSchema,
  minorToEur,
  summarise,
  type DraftResponse,
} from "./imports-draft";
import { UnknownInstrumentForm } from "./UnknownInstrumentForm";

/** Which upload path produced the current `draft`, so resolving an unknown instrument re-previews the right one. */
type Source = "file" | "paste";

export const ImportsPage = () => {
  const queryClient = useQueryClient();
  const [source, setSource] = useState<Source>("file");
  const [file, setFile] = useState<File | null>(null);
  const [pasteText, setPasteText] = useState("");
  const [accountId, setAccountId] = useState<number | null>(null);
  const [draft, setDraft] = useState<DraftResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const accounts = useQuery({
    queryKey: ["accounts"],
    queryFn: () => apiGet("/api/accounts", AccountsSchema),
  });

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
    mutationFn: () => apiUpload("/api/imports/preview", fileForm(), DraftResponseSchema),
    onSuccess: (data) => {
      setDraft(data);
      setError(null);
      setResult(null);
    },
    onError: (cause) =>
      setError(cause instanceof ApiError ? cause.message : "Esikatselu epäonnistui"),
  });

  const commitFile = useMutation({
    mutationFn: () => apiUpload("/api/imports/commit", fileForm(), CommitResultSchema),
    onSuccess: (data) => {
      setResult(`${data.inserted} tapahtumaa tuotu, ${data.skipped} ohitettu kaksoiskappaleena.`);
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
    mutationFn: () => apiPost("/api/imports/op-paste/preview", pasteBody(), DraftResponseSchema),
    onSuccess: (data) => {
      setDraft(data);
      setError(null);
      setResult(null);
    },
    onError: (cause) =>
      setError(cause instanceof ApiError ? cause.message : "Esikatselu epäonnistui"),
  });

  const commitPaste = useMutation({
    mutationFn: () => apiPost("/api/imports/op-paste/commit", pasteBody(), CommitResultSchema),
    onSuccess: (data) => {
      setResult(`${data.inserted} tapahtumaa tuotu, ${data.skipped} ohitettu kaksoiskappaleena.`);
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

            <table>
              <thead>
                <tr>
                  <th>Rivi</th>
                  <th>Päivä</th>
                  <th>Laji</th>
                  <th>ISIN</th>
                  <th className="num">Summa</th>
                </tr>
              </thead>
              <tbody>
                {draft.txns.slice(0, 50).map((t) => (
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
            {draft.txns.length > 50 && (
              <p className="mt-3 text-muted">…ja {draft.txns.length - 50} riviä lisää.</p>
            )}
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
    </>
  );
};

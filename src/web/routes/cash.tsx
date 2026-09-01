import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getAccounts } from "../server/accounts.ts";
import { useState } from "react";

import {
  commitBankImport,
  previewBankImport,
  recordAccountBalance,
} from "../server/bank-imports.ts";
import { eur, fiDate } from "../lib/format.ts";
import { accountTypeLabel } from "./account-type.ts";
import {
  availabilityLabel,
  describeBalance,
  describeImport,
  describeMaturity,
  describeReconciliation,
  ENTRY_LABELS,
} from "./cash-view.ts";
import { CreateAccountForm } from "./CreateAccountForm.tsx";
import { getCash } from "../server/portfolio.ts";
import { deleteCashEntry, getCashEntries, saveCashEntry } from "../server/cash-entries.ts";

/** What a person can record by hand, as the ledger stores it. */
type CashEntryType = "OPENING_BALANCE" | "DEPOSIT" | "WITHDRAWAL" | "INTEREST";

const today = (): string => new Date().toISOString().slice(0, 10);
/**
 * Bank accounts: what they hold, what a statement adds to them, and where the
 * money went.
 *
 * Cash counts toward what the portfolio is worth and toward its allocation, and
 * never toward the return figures -- a bank account's spending is not portfolio
 * performance. That split is stated on the screen rather than left for someone
 * to infer from two numbers that disagree.
 */
export const CashPage = () => {
  const queryClient = useQueryClient();
  const [accountId, setAccountId] = useState<number | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [balance, setBalance] = useState("");
  const [showNewAccount, setShowNewAccount] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accounts = useQuery({
    queryKey: ["accounts"],
    queryFn: () => getAccounts(),
  });
  const cash = useQuery({ queryKey: ["cash"], queryFn: () => getCash({ data: {} }) });

  const bankAccounts = (accounts.data ?? []).filter((account) => account.kind === "bank");
  const chosen = accountId ?? bankAccounts[0]?.id ?? null;

  const entries = useQuery({
    queryKey: ["cash-entries", chosen],
    enabled: chosen !== null,
    // `enabled` below keeps this from running while nothing is chosen; the
    // ?? 0 satisfies the argument type, which is a number rather than a
    // maybe-number.
    queryFn: () => getCashEntries({ data: { accountId: chosen ?? 0 } }),
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["cash"] });
    void queryClient.invalidateQueries({ queryKey: ["cash-entries"] });
    void queryClient.invalidateQueries({ queryKey: ["spending"] });
    void queryClient.invalidateQueries({ queryKey: ["returns"] });
  };

  const preview = useMutation({
    mutationFn: (form: FormData) => previewBankImport({ data: form }),
    onError: (cause) => setError(cause instanceof Error ? cause.message : "Esikatselu epäonnistui"),
  });

  const commit = useMutation({
    mutationFn: (form: FormData) => commitBankImport({ data: form }),
    onSuccess: () => {
      setError(null);
      preview.reset();
      setFile(null);
      refresh();
    },
    onError: (cause) => setError(cause instanceof Error ? cause.message : "Tuonti epäonnistui"),
  });

  const reconcile = useMutation({
    mutationFn: () =>
      recordAccountBalance({
        data: { accountId: chosen ?? 0, on: today(), balance: balance.replace(",", ".") },
      }),
    onSuccess: () => {
      setError(null);
      setBalance("");
      refresh();
    },
    onError: (cause) =>
      setError(cause instanceof Error ? cause.message : "Saldon tallennus epäonnistui"),
  });

  const removeEntry = useMutation({
    mutationFn: (id: number) => deleteCashEntry({ data: { id } }),
    onSuccess: refresh,
  });

  const formFor = (): FormData | null => {
    if (!file || chosen === null) return null;
    const form = new FormData();
    form.append("file", file);
    form.append("accountId", String(chosen));
    return form;
  };

  return (
    <section className="grid gap-8">
      <div>
        <h1>Käteinen</h1>
        <p className="max-w-prose text-muted">
          Pankkitilien saldot lasketaan tapahtumista. Käteinen on mukana salkun arvossa ja
          jakaumassa, mutta ei tuottoluvuissa: ruokaostos ei ole sijoitustappio.
        </p>
      </div>

      {error !== null && (
        <p role="alert" className="text-loss">
          {error}
        </p>
      )}

      <div className="card">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm text-muted">Käteinen yhteensä</h2>
          <span className="text-2xl">{eur(cash.data?.totalEur ?? "0.00")}</span>
        </div>
        {cash.data && cash.data.lockedEur !== "0.00" && (
          <p className="text-muted text-sm">
            Käytettävissä {eur(cash.data.availableEur)} · sidottuna määräaikaistalletuksissa{" "}
            {eur(cash.data.lockedEur)}
          </p>
        )}
        <div className="mt-3 max-h-80 overflow-auto rounded border border-line">
          <table>
            <thead className="sticky top-0 bg-surface">
              <tr>
                <th>Tili</th>
                <th>Valuutta</th>
                <th className="text-right">Saldo</th>
                <th className="text-right">EUR</th>
                <th>Saatavuus</th>
              </tr>
            </thead>
            <tbody>
              {(cash.data?.rows ?? []).map((row) => (
                <tr key={`${row.accountId}-${row.currency}`}>
                  <td>{row.accountName}</td>
                  <td>{row.currency}</td>
                  <td className="text-right">{row.amount}</td>
                  <td className="text-right">
                    {row.valueEur === null ? "kurssi puuttuu" : eur(row.valueEur)}
                  </td>
                  <td className={row.locked ? "text-muted" : ""}>{availabilityLabel(row)}</td>
                </tr>
              ))}
              {(cash.data?.rows ?? []).length === 0 && (
                <tr>
                  <td colSpan={5} className="text-muted">
                    Ei käteistä. Luo pankkitili ja tuo tiliote tai kirjaa saldo käsin.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card grid gap-3">
        <div className="flex flex-wrap items-end gap-3">
          <label>
            Pankkitili
            <select
              value={chosen ?? ""}
              onChange={(event) => setAccountId(Number(event.target.value))}
            >
              {bankAccounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name} · {accountTypeLabel(account.accountType)}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="text-sm" onClick={() => setShowNewAccount((v) => !v)}>
            {showNewAccount ? "Peruuta" : "+ Uusi pankkitili"}
          </button>
        </div>

        {showNewAccount && (
          <CreateAccountForm
            onCreated={(account) => {
              setShowNewAccount(false);
              setAccountId(account.id);
              void queryClient.invalidateQueries({ queryKey: ["accounts"] });
            }}
          />
        )}

        {bankAccounts.length === 0 && (
          <p className="text-muted text-sm">
            Ei vielä pankkitilejä. Luo tili ja valitse tyypiksi pankkitili.
          </p>
        )}
      </div>

      {chosen !== null && (
        <>
          <div className="card grid gap-3">
            <h2>Tuo tiliote</h2>
            <p className="text-muted text-sm">
              OP:n tapahtumavienti (CSV) tai tiliote (PDF). Sama tiedosto voidaan tuoda uudelleen:
              jo tuodut rivit ohitetaan pankin arkistointitunnuksen perusteella. Saman jakson voi
              tuoda molemmissa muodoissa — PDF täydentää saajatiedot, jotka CSV jättää tyhjiksi.
            </p>
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(event) => {
                setFile(event.target.files?.[0] ?? null);
                preview.reset();
              }}
            />
            <div className="flex gap-2">
              <button
                type="button"
                disabled={!file || preview.isPending}
                onClick={() => {
                  const form = formFor();
                  if (form) preview.mutate(form);
                }}
              >
                {preview.isPending ? "Luetaan…" : "Esikatsele"}
              </button>
              <button
                type="button"
                disabled={!preview.data || commit.isPending}
                onClick={() => {
                  const form = formFor();
                  if (form) commit.mutate(form);
                }}
              >
                {commit.isPending ? "Tuodaan…" : "Tuo"}
              </button>
            </div>

            {preview.data && (
              <div className="grid gap-2">
                <p>
                  {preview.data.rows} tapahtumaa {fiDate(preview.data.from ?? "")}–
                  {fiDate(preview.data.to ?? "")}. Sisään {eur(preview.data.totalInEur)}, ulos{" "}
                  {eur(preview.data.totalOutEur)}.
                </p>
                {preview.data.verified && (
                  <p className="text-muted text-sm">
                    Tiliote ilmoittaa saldoksi {eur(preview.data.openingBalanceEur ?? "0.00")} →{" "}
                    {eur(preview.data.closingBalanceEur ?? "0.00")}, ja rivit täsmäävät siihen.
                    Alkusaldo kirjataan automaattisesti.
                    {preview.data.maturityDate !== null &&
                      ` Erääntyy ${fiDate(preview.data.maturityDate)}.`}
                  </p>
                )}
                {preview.data.problems.length > 0 && (
                  <p className="text-loss text-sm">
                    {preview.data.problems.length} riviä ei voitu lukea; muut tuodaan.
                  </p>
                )}
                {/* A statement runs to hundreds of rows; the preview scrolls
                    inside its own box rather than pushing the import button off
                    the screen. */}
                <div className="max-h-80 overflow-auto rounded border border-line">
                  <table>
                    <tbody>
                      {preview.data.sample.map((row, index) => (
                        <tr key={`${row.date}-${index}`}>
                          <td>{fiDate(row.date)}</td>
                          <td className="text-right">{eur(row.amountEur)}</td>
                          <td className="text-muted">{row.note}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {commit.data && (
              <>
                <p>{describeImport(commit.data)}</p>
                {describeMaturity(commit.data) !== null && (
                  <p className={commit.data.maturityConflict === null ? "" : "text-loss"}>
                    {describeMaturity(commit.data)}
                  </p>
                )}
                {commit.data.reconciliation && (
                  <p
                    className={
                      commit.data.reconciliation.differenceEur === "0.00" ? "" : "text-loss"
                    }
                  >
                    {describeReconciliation(commit.data.reconciliation)}
                  </p>
                )}
              </>
            )}
          </div>

          <div className="card grid gap-3">
            <h2>Täsmäytä saldo</h2>
            <p className="max-w-prose text-muted text-sm">
              Syötä tilin saldo tänään. Sovellus kirjaa erotuksen alkusaldoksi, koska tiliote ei
              yleensä ulotu tilin avaamiseen asti. Kun ajat tämän myöhemmin uudelleen ja erotus on
              nolla, tuodut tapahtumat täsmäävät edelleen pankin kanssa.
            </p>
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                reconcile.mutate();
              }}
            >
              <label>
                Saldo tänään
                <input
                  value={balance}
                  inputMode="decimal"
                  placeholder="10000.00"
                  onChange={(event) => setBalance(event.target.value)}
                />
              </label>
              <button type="submit" disabled={balance.trim() === "" || reconcile.isPending}>
                {reconcile.isPending ? "Tallennetaan…" : "Tallenna saldo"}
              </button>
            </form>
            {reconcile.data && <p>{describeBalance(reconcile.data)}</p>}
          </div>

          <div className="card grid gap-3">
            <h2>Käsin kirjatut tapahtumat</h2>
            <p className="text-muted text-sm">
              Tilille, jolta ei saa tiliotetta (esim. Ferratum), tapahtumat voi kirjata käsin.
            </p>
            <ManualEntryForm accountId={chosen} onSaved={refresh} onError={setError} />
            <div className="max-h-96 overflow-auto rounded border border-line">
              <table>
                <tbody>
                  {(entries.data?.entries ?? []).map((entry) => (
                    <tr key={entry.id}>
                      <td>{fiDate(entry.tradeDate)}</td>
                      <td>{ENTRY_LABELS.get(entry.type) ?? entry.type}</td>
                      <td className="text-right">{entry.amount}</td>
                      <td>{entry.currency}</td>
                      <td className="text-muted">{entry.note}</td>
                      <td>
                        <button
                          type="button"
                          className="text-sm"
                          aria-label={`Poista tapahtuma ${entry.tradeDate}`}
                          onClick={() => removeEntry.mutate(entry.id)}
                        >
                          Poista
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </section>
  );
};

/** Money in, money out, or interest, for an account no bank exports. */
const ManualEntryForm = ({
  accountId,
  onSaved,
  onError,
}: {
  readonly accountId: number;
  readonly onSaved: () => void;
  readonly onError: (message: string) => void;
}) => {
  // The four kinds the ledger stores, rather than a string: the schema takes
  // exactly these, and the select can produce nothing else.
  const [type, setType] = useState<CashEntryType>("DEPOSIT");
  const [tradeDate, setTradeDate] = useState(today);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");

  const save = useMutation({
    mutationFn: () => {
      // The note is left out entirely when empty rather than sent as "": the
      // schema takes an optional string, and a blank one would store a note
      // that says nothing.
      const entry = { accountId, type, tradeDate, amount: amount.replace(",", ".") };
      const trimmed = note.trim();
      return saveCashEntry({ data: trimmed === "" ? entry : { ...entry, note: trimmed } });
    },
    onSuccess: () => {
      setAmount("");
      setNote("");
      onSaved();
    },
    onError: (cause) =>
      onError(cause instanceof Error ? cause.message : "Tapahtuman tallennus epäonnistui"),
  });

  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <label>
        Laji
        <select
          value={type}
          onChange={(event) => {
            // SAFETY: the options are rendered from the same four values.
            setType(event.target.value as CashEntryType);
          }}
        >
          <option value="DEPOSIT">Talletus</option>
          <option value="WITHDRAWAL">Nosto</option>
          <option value="INTEREST">Korko</option>
          <option value="OPENING_BALANCE">Alkusaldo</option>
        </select>
      </label>
      <label>
        Päivä
        <input
          type="date"
          value={tradeDate}
          onChange={(event) => setTradeDate(event.target.value)}
        />
      </label>
      <label>
        Summa
        <input
          value={amount}
          inputMode="decimal"
          placeholder="1000.00"
          onChange={(event) => setAmount(event.target.value)}
        />
      </label>
      <label>
        Selite
        <input value={note} maxLength={200} onChange={(event) => setNote(event.target.value)} />
      </label>
      <button type="submit" disabled={amount.trim() === "" || save.isPending}>
        {save.isPending ? "Tallennetaan…" : "Kirjaa"}
      </button>
    </form>
  );
};

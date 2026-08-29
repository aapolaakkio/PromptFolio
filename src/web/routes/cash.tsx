import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { ApiError, apiDelete, apiGet, apiPost, apiUpload } from "../lib/api";
import { eur, fiDate } from "../lib/format";
import { accountTypeLabel } from "./account-type";
import {
  BalanceSchema,
  BankCommitSchema,
  BankPreviewSchema,
  CashEntriesSchema,
  CashSchema,
  describeBalance,
  describeImport,
  ENTRY_LABELS,
  SpendingSchema,
} from "./cash-view";
import { AccountsSchema } from "./imports-draft";
import { CreateAccountForm } from "./CreateAccountForm";

const today = (): string => new Date().toISOString().slice(0, 10);
const yearAgo = (): string => {
  const date = new Date();
  date.setUTCFullYear(date.getUTCFullYear() - 1);
  return date.toISOString().slice(0, 10);
};

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
  const [from, setFrom] = useState(yearAgo);
  const [to, setTo] = useState(today);
  const [groupBy, setGroupBy] = useState<"category" | "counterparty">("category");
  const [showNewAccount, setShowNewAccount] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accounts = useQuery({
    queryKey: ["accounts"],
    queryFn: () => apiGet("/api/accounts", AccountsSchema),
  });
  const cash = useQuery({ queryKey: ["cash"], queryFn: () => apiGet("/api/cash", CashSchema) });
  const spending = useQuery({
    queryKey: ["spending", from, to, groupBy],
    queryFn: () => apiGet(`/api/spending?from=${from}&to=${to}&by=${groupBy}`, SpendingSchema),
  });

  const bankAccounts = (accounts.data ?? []).filter((account) => account.kind === "bank");
  const chosen = accountId ?? bankAccounts[0]?.id ?? null;

  const entries = useQuery({
    queryKey: ["cash-entries", chosen],
    enabled: chosen !== null,
    queryFn: () => apiGet(`/api/cash-entries?accountId=${chosen}`, CashEntriesSchema),
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["cash"] });
    void queryClient.invalidateQueries({ queryKey: ["cash-entries"] });
    void queryClient.invalidateQueries({ queryKey: ["spending"] });
    void queryClient.invalidateQueries({ queryKey: ["returns"] });
  };

  const preview = useMutation({
    mutationFn: (form: FormData) => apiUpload("/api/imports/bank/preview", form, BankPreviewSchema),
    onError: (cause) =>
      setError(cause instanceof ApiError ? cause.message : "Esikatselu epäonnistui"),
  });

  const commit = useMutation({
    mutationFn: (form: FormData) => apiUpload("/api/imports/bank/commit", form, BankCommitSchema),
    onSuccess: () => {
      setError(null);
      preview.reset();
      setFile(null);
      refresh();
    },
    onError: (cause) => setError(cause instanceof ApiError ? cause.message : "Tuonti epäonnistui"),
  });

  const reconcile = useMutation({
    mutationFn: () =>
      apiPost(
        `/api/accounts/${chosen}/balance`,
        { on: today(), balance: balance.replace(",", ".") },
        BalanceSchema,
      ),
    onSuccess: () => {
      setError(null);
      setBalance("");
      refresh();
    },
    onError: (cause) =>
      setError(cause instanceof ApiError ? cause.message : "Saldon tallennus epäonnistui"),
  });

  const removeEntry = useMutation({
    mutationFn: (id: number) => apiDelete(`/api/cash-entries/${id}`),
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
        <div className="mt-3 max-h-80 overflow-auto rounded border border-line">
          <table>
            <thead className="sticky top-0 bg-surface">
              <tr>
                <th>Tili</th>
                <th>Valuutta</th>
                <th className="text-right">Saldo</th>
                <th className="text-right">EUR</th>
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
                </tr>
              ))}
              {(cash.data?.rows ?? []).length === 0 && (
                <tr>
                  <td colSpan={4} className="text-muted">
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
              OP:n tapahtumavienti (CSV). Sama tiedosto voidaan tuoda uudelleen: jo tuodut rivit
              ohitetaan pankin arkistointitunnuksen perusteella.
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

            {commit.data && <p>{describeImport(commit.data)}</p>}
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

      <div className="card grid gap-3">
        <h2>Mihin raha meni</h2>
        <div className="flex flex-wrap items-end gap-2">
          <label>
            Alkaen
            <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </label>
          <label>
            Asti
            <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </label>
          <label>
            Ryhmittely
            <select
              value={groupBy}
              onChange={(event) =>
                setGroupBy(event.target.value === "counterparty" ? "counterparty" : "category")
              }
            >
              <option value="category">Luokittain</option>
              <option value="counterparty">Saajittain</option>
            </select>
          </label>
        </div>

        <div className="max-h-96 overflow-auto rounded border border-line">
          <table>
            <thead className="sticky top-0 bg-surface">
              <tr>
                <th>{groupBy === "category" ? "Luokka" : "Saaja"}</th>
                <th className="text-right">Tapahtumia</th>
                <th className="text-right">Yhteensä</th>
              </tr>
            </thead>
            <tbody>
              {(spending.data?.groups ?? []).map((group) => (
                <tr key={group.key}>
                  <td>{group.label}</td>
                  <td className="text-right">{group.count}</td>
                  <td className="text-right">{eur(group.totalEur)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {spending.data && (
          <p className="text-muted text-sm">
            Yhteensä {eur(spending.data.totalEur)}.{" "}
            {spending.data.uncategorisedShare > 0.05 &&
              `Luokittelematta ${Math.round(spending.data.uncategorisedShare * 100)} % — nämä näkyvät luokassa Muu.`}
          </p>
        )}
      </div>
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
  const [type, setType] = useState("DEPOSIT");
  const [tradeDate, setTradeDate] = useState(today);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");

  const save = useMutation({
    mutationFn: () => {
      // The note is left out entirely when empty rather than sent as "": the
      // route's schema takes an optional string, and a blank one would store a
      // note that says nothing.
      const entry = { accountId, type, tradeDate, amount: amount.replace(",", ".") };
      const trimmed = note.trim();
      return apiPost("/api/cash-entries", trimmed === "" ? entry : { ...entry, note: trimmed });
    },
    onSuccess: () => {
      setAmount("");
      setNote("");
      onSaved();
    },
    onError: (cause) =>
      onError(cause instanceof ApiError ? cause.message : "Tapahtuman tallennus epäonnistui"),
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
        <select value={type} onChange={(event) => setType(event.target.value)}>
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

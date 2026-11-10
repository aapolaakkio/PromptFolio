import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { errorMessage } from "../lib/errors.ts";
import { getAccounts } from "../server/accounts.ts";
import { useState } from "react";

import { recordAccountBalance } from "../server/bank-imports.ts";
import { eur, formatDate } from "../lib/format.ts";
import { accountTypeLabel } from "./account-type.ts";
import { availabilityLabel, describeBalance, ENTRY_LABELS } from "./cash-view.ts";
import { CreateAccountForm } from "./CreateAccountForm.tsx";
import { getCash } from "../server/portfolio.ts";
import { deleteCashEntry, getCashEntries, saveCashEntry } from "../server/cash-entries.ts";
import { Modal } from "./Modal.tsx";
import { usePublishSelection } from "./assistant-context.ts";

/** What a person can record by hand, as the ledger stores it. */
type CashEntryType = "OPENING_BALANCE" | "DEPOSIT" | "WITHDRAWAL" | "INTEREST";

const today = (): string => new Date().toISOString().slice(0, 10);
/** Bank accounts: holdings, statements, spending. Cash counts toward portfolio value and allocation but never toward returns; the screen says so. */
export const CashPage = () => {
  const queryClient = useQueryClient();
  const [accountId, setAccountId] = useState<number | null>(null);
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
  usePublishSelection(chosen);

  const entries = useQuery({
    queryKey: ["cash-entries", chosen],
    enabled: chosen !== null,
    // `enabled` below guards this; `?? 0` only satisfies the argument type.
    queryFn: () => getCashEntries({ data: { accountId: chosen ?? 0 } }),
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["cash"] });
    void queryClient.invalidateQueries({ queryKey: ["cash-entries"] });
    void queryClient.invalidateQueries({ queryKey: ["spending"] });
    void queryClient.invalidateQueries({ queryKey: ["returns"] });
  };

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
    onError: (cause) => setError(errorMessage(cause, "Could not save the balance")),
  });

  const removeEntry = useMutation({
    mutationFn: (id: number) => deleteCashEntry({ data: { id } }),
    onSuccess: refresh,
  });

  return (
    <section className="grid gap-8">
      <div>
        <h1>Cash</h1>
        <p className="max-w-prose text-muted">
          Bank account balances are calculated from transactions. Cash counts towards the portfolio
          value and allocation, but not the return figures: a grocery purchase is not an investment
          loss.
        </p>
      </div>

      {error !== null && (
        <p role="alert" className="text-loss">
          {error}
        </p>
      )}

      <div className="card">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm text-muted">Total cash</h2>
          <span className="text-2xl">{eur(cash.data?.totalEur ?? "0.00")}</span>
        </div>
        {cash.data && cash.data.lockedEur !== "0.00" && (
          <p className="text-muted text-sm">
            Available {eur(cash.data.availableEur)} · locked in fixed-term deposits{" "}
            {eur(cash.data.lockedEur)}
          </p>
        )}
        <div className="mt-3 max-h-80 overflow-auto rounded border border-line">
          <table>
            <thead className="sticky top-0 bg-surface">
              <tr>
                <th>Account</th>
                <th>Currency</th>
                <th className="text-right">Balance</th>
                <th className="text-right">EUR</th>
                <th>Availability</th>
              </tr>
            </thead>
            <tbody>
              {(cash.data?.rows ?? []).map((row) => (
                <tr key={`${row.accountId}-${row.currency}`}>
                  <td>{row.accountName}</td>
                  <td>{row.currency}</td>
                  <td className="text-right">{row.amount}</td>
                  <td className="text-right">
                    {row.valueEur === null ? "rate missing" : eur(row.valueEur)}
                  </td>
                  <td className={row.locked ? "text-muted" : ""}>{availabilityLabel(row)}</td>
                </tr>
              ))}
              {(cash.data?.rows ?? []).length === 0 && (
                <tr>
                  <td colSpan={5} className="text-muted">
                    No cash. Create a bank account and import a bank statement, or record a balance
                    by hand.
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
            Bank account
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
          <button type="button" className="text-sm" onClick={() => setShowNewAccount(true)}>
            + New bank account
          </button>
        </div>

        {showNewAccount && (
          <Modal title="New bank account" onClose={() => setShowNewAccount(false)}>
            <CreateAccountForm
              onCreated={(account) => {
                setShowNewAccount(false);
                setAccountId(account.id);
                void queryClient.invalidateQueries({ queryKey: ["accounts"] });
              }}
            />
          </Modal>
        )}

        {bankAccounts.length === 0 && (
          <p className="text-muted text-sm">
            No bank accounts yet. Create an account and choose bank account as its type.
          </p>
        )}
      </div>

      {chosen !== null && (
        <>
          <div className="card grid gap-3">
            <h2>Reconcile balance</h2>
            <p className="max-w-prose text-muted text-sm">
              Enter the account balance today. The app records the difference as the opening
              balance, because a bank statement usually does not reach back to when the account was
              opened. If you run this again later and the difference is zero, the imported
              transactions still match the bank.
            </p>
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                reconcile.mutate();
              }}
            >
              <label>
                Balance today
                <input
                  value={balance}
                  inputMode="decimal"
                  placeholder="10000.00"
                  onChange={(event) => setBalance(event.target.value)}
                />
              </label>
              <button type="submit" disabled={balance.trim() === "" || reconcile.isPending}>
                {reconcile.isPending ? "Saving…" : "Save balance"}
              </button>
            </form>
            {reconcile.data && <p>{describeBalance(reconcile.data)}</p>}
          </div>

          <div className="card grid gap-3">
            <h2>Manual entries</h2>
            <p className="text-muted text-sm">
              For an account that has no bank statement (e.g. Ferratum), record transactions by
              hand.
            </p>
            <ManualEntryForm accountId={chosen} onSaved={refresh} onError={setError} />
            <div className="max-h-96 overflow-auto rounded border border-line">
              <table>
                <tbody>
                  {(entries.data?.entries ?? []).map((entry) => (
                    <tr key={entry.id}>
                      <td>{formatDate(entry.tradeDate)}</td>
                      <td>{ENTRY_LABELS.get(entry.type) ?? entry.type}</td>
                      <td className="text-right">{entry.amount}</td>
                      <td>{entry.currency}</td>
                      <td className="text-muted">{entry.note}</td>
                      <td>
                        <button
                          type="button"
                          className="text-sm"
                          aria-label={`Delete entry ${entry.tradeDate}`}
                          onClick={() => removeEntry.mutate(entry.id)}
                        >
                          Delete
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
  // The four kinds the ledger stores; the schema takes exactly these.
  const [type, setType] = useState<CashEntryType>("DEPOSIT");
  const [tradeDate, setTradeDate] = useState(today);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");

  const save = useMutation({
    mutationFn: () => {
      // An empty note is omitted rather than sent as "".
      const entry = { accountId, type, tradeDate, amount: amount.replace(",", ".") };
      const trimmed = note.trim();
      return saveCashEntry({ data: trimmed === "" ? entry : { ...entry, note: trimmed } });
    },
    onSuccess: () => {
      setAmount("");
      setNote("");
      onSaved();
    },
    onError: (cause) => onError(errorMessage(cause, "Could not save the entry")),
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
        Type
        <select
          value={type}
          onChange={(event) => {
            // SAFETY: the options are rendered from the same four values.
            setType(event.target.value as CashEntryType);
          }}
        >
          <option value="DEPOSIT">Deposit</option>
          <option value="WITHDRAWAL">Withdrawal</option>
          <option value="INTEREST">Interest</option>
          <option value="OPENING_BALANCE">Opening balance</option>
        </select>
      </label>
      <label>
        Date
        <input
          type="date"
          value={tradeDate}
          onChange={(event) => setTradeDate(event.target.value)}
        />
      </label>
      <label>
        Amount
        <input
          value={amount}
          inputMode="decimal"
          placeholder="1000.00"
          onChange={(event) => setAmount(event.target.value)}
        />
      </label>
      <label>
        Note
        <input value={note} maxLength={200} onChange={(event) => setNote(event.target.value)} />
      </label>
      <button type="submit" disabled={amount.trim() === "" || save.isPending}>
        {save.isPending ? "Saving…" : "Record"}
      </button>
    </form>
  );
};

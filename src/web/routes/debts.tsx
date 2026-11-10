import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { eur, formatDate } from "../lib/format.ts";
import { errorMessage } from "../lib/errors.ts";
import { TimeSeriesChart } from "../charts/TimeSeriesChart.tsx";
import type { DebtView } from "../../server/debts.ts";
import {
  createDebt,
  deleteDebt,
  deleteDebtBalance,
  getDebts,
  saveDebtBalance,
} from "../server/debts.ts";
import { KIND_LABELS, stepPoints } from "./debts-view.ts";
import { Modal } from "./Modal.tsx";

const today = (): string => new Date().toISOString().slice(0, 10);

const DASHBOARD_KEYS = ["value-series", "returns", "allocation"] as const;

const useRefresh = () => {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ["debts"] });
    for (const key of DASHBOARD_KEYS) void queryClient.invalidateQueries({ queryKey: [key] });
  };
};

const ErrorLine = ({ message }: { message: string | null }) =>
  message === null ? null : (
    <p role="alert" className="text-loss">
      {message}
    </p>
  );

const AddDebtForm = () => {
  const refresh = useRefresh();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<DebtView["kind"]>("student_loan");
  const [rate, setRate] = useState("");
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => {
      const interestRatePct = rate.trim().replace(",", ".");
      return createDebt({
        data: interestRatePct === "" ? { name, kind } : { name, kind, interestRatePct },
      });
    },
    onSuccess: () => {
      setError(null);
      setName("");
      setRate("");
      refresh();
    },
    onError: (cause) => setError(errorMessage(cause, "Could not add the debt")),
  });

  const submit = (event: React.SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    create.mutate();
  };

  return (
    <form className="card grid gap-3" onSubmit={submit}>
      <h2>Add a debt</h2>
      <div className="flex flex-wrap items-end gap-3">
        <label>
          Name
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          Kind
          <select
            value={kind}
            // SAFETY: the options are rendered from KIND_LABELS' own keys.
            onChange={(event) => setKind(event.target.value as DebtView["kind"])}
          >
            {Object.entries(KIND_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Interest rate % (optional)
          <input
            value={rate}
            inputMode="decimal"
            onChange={(event) => setRate(event.target.value)}
          />
        </label>
        <button type="submit" disabled={create.isPending}>
          Add debt
        </button>
      </div>
      <ErrorLine message={error} />
    </form>
  );
};

const AddBalanceForm = ({ debtId }: { debtId: number }) => {
  const refresh = useRefresh();
  const [asOf, setAsOf] = useState(today());
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      saveDebtBalance({ data: { debtId, asOf, owedEur: amount.trim().replace(",", ".") } }),
    onSuccess: () => {
      setError(null);
      setAmount("");
      refresh();
    },
    onError: (cause) => setError(errorMessage(cause, "Could not save the balance")),
  });

  const submit = (event: React.SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    save.mutate();
  };

  return (
    <form className="grid gap-2" onSubmit={submit}>
      <h3 className="text-sm text-muted">Add a balance</h3>
      <div className="flex flex-wrap items-end gap-3">
        <label>
          Date
          <input type="date" value={asOf} max={today()} onChange={(e) => setAsOf(e.target.value)} />
        </label>
        <label>
          Owed (EUR)
          <input value={amount} inputMode="decimal" onChange={(e) => setAmount(e.target.value)} />
        </label>
        <button type="submit" disabled={save.isPending}>
          Save balance
        </button>
      </div>
      <ErrorLine message={error} />
    </form>
  );
};

const BalanceTable = ({ debt }: { debt: DebtView }) => {
  const refresh = useRefresh();
  const [error, setError] = useState<string | null>(null);
  const remove = useMutation({
    mutationFn: (asOf: string) => deleteDebtBalance({ data: { debtId: debt.id, asOf } }),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError: (cause) => setError(errorMessage(cause, "Could not remove the balance")),
  });

  return (
    <div className="grid gap-2">
      <div className="max-h-60 overflow-auto rounded border border-line">
        <table>
          <thead className="sticky top-0 bg-surface">
            <tr>
              <th>Date</th>
              <th className="text-right">Owed</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {debt.balances.map((balance) => (
              <tr key={balance.asOf}>
                <td>{formatDate(balance.asOf)}</td>
                <td className="text-right">{eur(balance.owedEur)}</td>
                <td className="text-right">
                  <button
                    type="button"
                    className="quiet-button"
                    aria-label={`Remove the balance of ${formatDate(balance.asOf)}`}
                    onClick={() => remove.mutate(balance.asOf)}
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ErrorLine message={error} />
    </div>
  );
};

const RemoveDebtModal = ({ debt, onClose }: { debt: DebtView; onClose: () => void }) => {
  const refresh = useRefresh();
  const [error, setError] = useState<string | null>(null);
  const remove = useMutation({
    mutationFn: () => deleteDebt({ data: { debtId: debt.id } }),
    onSuccess: () => {
      refresh();
      onClose();
    },
    onError: (cause) => setError(errorMessage(cause, "Could not remove the debt")),
  });

  return (
    <Modal title={`Remove ${debt.name}?`} onClose={onClose}>
      <div className="grid gap-3">
        <p className="rounded border border-loss p-3 text-sm">
          This also removes all of its balances. It cannot be undone.
        </p>
        <ErrorLine message={error} />
        <div className="flex gap-3">
          <button type="button" className="border-loss" onClick={() => remove.mutate()}>
            Delete
          </button>
          <button type="button" className="quiet-button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
};

const DebtCard = ({ debt }: { debt: DebtView }) => {
  const [confirming, setConfirming] = useState(false);
  const hasBalance = debt.balances.length > 0;

  return (
    <div className="card grid gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h2 className="mb-0">{debt.name}</h2>
          <p className="text-sm text-muted">
            {KIND_LABELS[debt.kind]}
            {debt.interestRatePct !== null && ` · interest ${debt.interestRatePct} %`}
          </p>
        </div>
        <div className="text-right">
          <div className="font-mono tabular-nums text-2xl">
            {debt.asOf === null ? "No balance yet" : eur(debt.owedEur)}
          </div>
          {debt.asOf !== null && (
            <div className="text-xs text-muted">Owed, as of {formatDate(debt.asOf)}</div>
          )}
        </div>
      </div>
      {hasBalance && <BalanceTable debt={debt} />}
      {hasBalance && <TimeSeriesChart label="Owed" points={stepPoints(debt.balances, today())} />}
      <AddBalanceForm debtId={debt.id} />
      <div>
        <button
          type="button"
          className="quiet-button text-loss"
          onClick={() => setConfirming(true)}
        >
          Remove debt
        </button>
      </div>
      {confirming && <RemoveDebtModal debt={debt} onClose={() => setConfirming(false)} />}
    </div>
  );
};

export const DebtsPage = () => {
  const debts = useQuery({ queryKey: ["debts"], queryFn: () => getDebts({ data: {} }) });

  return (
    <section className="grid gap-8">
      <h1>Debts</h1>
      <ErrorLine message={debts.error ? errorMessage(debts.error, "Could not load debts") : null} />
      <div className="card">
        <div className="text-sm text-muted">Owed in total</div>
        <div className="font-mono tabular-nums text-2xl">
          {eur(debts.data?.totalOwedEur ?? "0.00")}
        </div>
      </div>
      {debts.data?.debts.length === 0 && (
        <p className="text-muted">
          No debts yet. Add your student loan or credit card to see your net worth.
        </p>
      )}
      {(debts.data?.debts ?? []).map((debt) => (
        <DebtCard key={debt.id} debt={debt} />
      ))}
      <AddDebtForm />
    </section>
  );
};

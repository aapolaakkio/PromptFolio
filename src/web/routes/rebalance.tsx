import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { errorMessage } from "../lib/errors.ts";
import type { Dimension } from "../../core/allocation.ts";
import {
  getDepositPlan,
  getDrift,
  getFees,
  getRebalancePlan,
  getTargets,
  saveTargetAllocation,
} from "../server/rebalance.ts";
import { eur } from "../lib/format.ts";
import type { DriftRowView, TargetView } from "../../server/rebalance.ts";
import { targetTotal } from "./rebalance-view.ts";

const DIMENSIONS = [
  { value: "kind", label: "By kind" },
  { value: "currency", label: "By currency" },
  { value: "account", label: "By account" },
  { value: "instrument", label: "By instrument" },
] as const;

const today = (): string => new Date().toISOString().slice(0, 10);

const Badge = ({ children, title }: { children: string; title?: string }) => (
  <span
    className="ml-2 rounded-full border border-line px-2 py-0.5 text-xs text-muted"
    title={title}
  >
    {children}
  </span>
);

const pct = (value: string | null): string => (value === null ? "—" : `${value} %`);

/** Portfolio shape versus the owner's target. Drift is arithmetic and always shown; selling is advice, so the sell view is a disclosure and each sale shows its realised gain. */
const DriftTable = ({ rows }: { rows: readonly DriftRowView[] }) => {
  const targeted = rows.filter((row) => !row.untargeted);
  const untargeted = rows.filter((row) => row.untargeted);

  return (
    <>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-line text-left text-muted">
            <th className="py-2">Item</th>
            <th className="text-right">Target</th>
            <th className="text-right">Now</th>
            <th className="text-right">Difference</th>
            <th className="text-right">To move</th>
          </tr>
        </thead>
        <tbody>
          {targeted.map((row) => (
            <tr key={row.key} className="border-b border-line">
              <td className="py-2">{row.label}</td>
              <td className="text-right">{pct(row.targetPercent)}</td>
              <td className="text-right">{pct(row.actualPercent)}</td>
              <td className="text-right">
                {pct(row.driftPercent)}
                {row.withinBand && (
                  <Badge title="The difference is under five percentage points.">on target</Badge>
                )}
              </td>
              <td className="text-right">{row.driftEur === null ? "—" : eur(row.driftEur)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {untargeted.length > 0 && (
        <p className="mt-2 text-sm text-muted">
          {/* Untargeted is not targeted at zero: only the second implies selling. */}
          Without a target: {untargeted.map((row) => row.label).join(", ")}. No difference is
          calculated and no trades are suggested for these.
        </p>
      )}
    </>
  );
};

const TargetEditor = ({
  dimension,
  rows,
  onSaved,
}: {
  dimension: Dimension;
  rows: readonly DriftRowView[];
  onSaved: () => void;
}) => {
  const stored = useQuery({
    queryKey: ["targets", dimension],
    queryFn: () => getTargets({ data: { by: dimension } }),
  });
  const [draft, setDraft] = useState<TargetView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Stored targets, else every held slice so a first-time editor has rows.
  const targets =
    draft ??
    (stored.data !== undefined && stored.data.length > 0
      ? [...stored.data]
      : rows.map((row) => ({ key: row.key, weightPercent: "" })));

  const total = targetTotal(targets);
  const labelOf = (key: string) => rows.find((row) => row.key === key)?.label ?? key;

  const save = useMutation({
    mutationFn: () => saveTargetAllocation({ data: { dimension, targets } }),
    onSuccess: () => {
      setError(null);
      setDraft(null);
      onSaved();
    },
    // The server's message says what is wrong (what the set sums to, or which field it could not read).
    onError: (cause) => setError(errorMessage(cause, "Could not save")),
  });

  return (
    <section className="mt-6">
      <h2 className="mb-2 text-lg font-semibold">Target allocation</h2>
      <table className="w-full max-w-md border-collapse text-sm">
        <tbody>
          {targets.map((target, index) => (
            <tr key={target.key} className="border-b border-line">
              <td className="py-1">{labelOf(target.key)}</td>
              <td className="py-1 text-right">
                <input
                  value={target.weightPercent}
                  inputMode="decimal"
                  aria-label={`${labelOf(target.key)} target in percent`}
                  className="w-24 border border-line bg-surface px-2 py-1 text-right"
                  onChange={(event) =>
                    setDraft(
                      targets.map((row, at) =>
                        at === index ? { ...row, weightPercent: event.target.value } : row,
                      ),
                    )
                  }
                />{" "}
                %
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-sm">
        {/* Shown while typing: a set that does not sum to 100 % is refused. */}
        Total {total} %{" "}
        {total !== "100.00" && (
          <span className="text-muted">— the targets must add up to 100 %</span>
        )}
      </p>
      <button
        type="button"
        className="mt-2 border border-line px-3 py-1"
        disabled={save.isPending || total !== "100.00"}
        onClick={() => save.mutate()}
      >
        Save targets
      </button>
      {error !== null && <p className="mt-2 text-sm">{error}</p>}
    </section>
  );
};

export const RebalancePage = () => {
  const queryClient = useQueryClient();
  const [dimension, setDimension] = useState<Dimension>("kind");
  const [deposit, setDeposit] = useState("");
  const [showSells, setShowSells] = useState(false);

  const drift = useQuery({
    queryKey: ["drift", dimension],
    queryFn: () => getDrift({ data: { by: dimension, on: today() } }),
  });
  const depositPlan = useQuery({
    queryKey: ["deposit-plan", dimension, deposit],
    queryFn: () => getDepositPlan({ data: { by: dimension, on: today(), amount: deposit } }),
    enabled: /^\d+([.,]\d{1,2})?$/.test(deposit),
  });
  const plan = useQuery({
    queryKey: ["rebalance", dimension],
    queryFn: () => getRebalancePlan({ data: { by: dimension, on: today() } }),
    enabled: showSells,
  });
  const fees = useQuery({ queryKey: ["fees"], queryFn: () => getFees() });

  return (
    <>
      <h1>Rebalance</h1>
      <p className="text-muted">
        The difference from the target is calculated from your transactions. Suggestions are
        calculations, not investment advice — and for a sale, the gain it would realise is always
        shown.
      </p>

      <label className="mt-4 block">
        Group by{" "}
        <select
          value={dimension}
          onChange={(event) => {
            // SAFETY: the options are rendered from DIMENSIONS, which are exactly the Dimension union.
            setDimension(event.target.value as Dimension);
          }}
          className="border border-line bg-surface px-2 py-1"
        >
          {DIMENSIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      {drift.isPending && <p>Loading…</p>}
      {drift.data !== undefined && (
        <>
          {drift.data.incomplete && (
            <p className="mt-4 text-sm text-muted">
              {/* One unpriceable holding makes every slice's euro figure wrong by an unknown amount. */}
              A holding has no price, so differences in euros cannot be calculated. The percentages
              cover only the items that could be valued.
            </p>
          )}

          <section className="mt-6">
            <h2 className="mb-2 text-lg font-semibold">Difference from target</h2>
            <DriftTable rows={drift.data.rows} />
            <p className="mt-2 text-sm text-muted">Portfolio value {eur(drift.data.totalEur)}.</p>
          </section>

          <TargetEditor
            dimension={dimension}
            rows={drift.data.rows}
            onSaved={() => {
              void queryClient.invalidateQueries({ queryKey: ["drift"] });
              void queryClient.invalidateQueries({ queryKey: ["rebalance"] });
              void queryClient.invalidateQueries({ queryKey: ["deposit-plan"] });
            }}
          />

          <section className="mt-8">
            <h2 className="mb-2 text-lg font-semibold">New investment</h2>
            <p className="text-sm text-muted">
              Where to put the next investment. No selling, no realised gain.
            </p>
            <label className="mt-2 block">
              Amount{" "}
              <input
                value={deposit}
                inputMode="decimal"
                className="w-32 border border-line bg-surface px-2 py-1 text-right"
                onChange={(event) => setDeposit(event.target.value)}
              />{" "}
              €
            </label>
            {depositPlan.data !== undefined &&
              (depositPlan.data.length === 0 ? (
                <p className="mt-2 text-muted">No destination — the targets are already full.</p>
              ) : (
                <ul className="mt-2 text-sm">
                  {depositPlan.data.map((allocation) => (
                    <li key={allocation.key}>
                      {allocation.label}: {eur(allocation.amountEur)}
                    </li>
                  ))}
                </ul>
              ))}
          </section>

          <section className="mt-8">
            <h2 className="mb-2 text-lg font-semibold">Full rebalance</h2>
            {!showSells ? (
              <button
                type="button"
                className="border border-line px-3 py-1"
                onClick={() => setShowSells(true)}
              >
                Also show sales
              </button>
            ) : plan.data === undefined ? (
              <p>Loading…</p>
            ) : plan.data.trades.length === 0 ? (
              <p className="text-muted">No trades — the portfolio is on target.</p>
            ) : (
              <>
                <p className="mb-2 text-sm">
                  The sales would realise a total gain of {eur(plan.data.totalRealisedGainEur)}
                  {plan.data.gainIncomplete && " (cost basis unknown for some)"}. This is gain, not
                  tax.
                </p>
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-line text-left text-muted">
                      <th className="py-2">Item</th>
                      <th>Action</th>
                      <th className="text-right">Amount</th>
                      <th className="text-right">Realised gain</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.data.trades.map((trade) => (
                      <tr key={`${trade.key}-${trade.side}`} className="border-b border-line">
                        <td className="py-2">{trade.label}</td>
                        <td>{trade.side === "buy" ? "Buy" : "Sell"}</td>
                        <td className="text-right">{eur(trade.amountEur)}</td>
                        <td className="text-right">
                          {trade.side === "buy"
                            ? "—"
                            : trade.gainUnknown
                              ? "unknown"
                              : eur(trade.realisedGainEur ?? "0")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {plan.data.tooSmall.length > 0 && (
                  <p className="mt-2 text-sm text-muted">
                    {/* Listed rather than hidden: the owner may have a reason. */}
                    Trades under €50 were left out:{" "}
                    {plan.data.tooSmall
                      .map((trade) => `${trade.label} ${eur(trade.amountEur)}`)
                      .join(", ")}
                    .
                  </p>
                )}
              </>
            )}
          </section>
        </>
      )}

      <section className="mt-8">
        <h2 className="mb-2 text-lg font-semibold">Fees</h2>
        {fees.data !== undefined && fees.data.length === 0 && (
          <p className="text-muted">No fees.</p>
        )}
        {fees.data !== undefined && fees.data.length > 0 && (
          <>
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-line text-left text-muted">
                  <th className="py-2">Year</th>
                  <th className="text-right">Trading fees</th>
                  <th className="text-right">Service charges</th>
                  <th className="text-right">Total</th>
                  <th className="text-right">Tax withheld</th>
                </tr>
              </thead>
              <tbody>
                {fees.data.map((year) => (
                  <tr key={year.year} className="border-b border-line">
                    <td className="py-2">{year.year}</td>
                    <td className="text-right">{eur(year.tradeFeesEur)}</td>
                    <td className="text-right">{eur(year.chargedFeesEur)}</td>
                    <td className="text-right">{eur(year.totalEur)}</td>
                    <td className="text-right">{eur(year.withheldTaxEur)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-sm text-muted">
              Capital gains tax withheld on an equity savings account (OST) is its own column and
              not part of the fees: it is tax on profit, not a cost of investing.
            </p>
          </>
        )}
      </section>
    </>
  );
};

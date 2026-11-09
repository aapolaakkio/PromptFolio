import { useQuery } from "@tanstack/react-query";
import { eur, pct, formatDate } from "../lib/format.ts";
import { TimeSeriesChart } from "../charts/TimeSeriesChart.tsx";
import { AllocationChart } from "../charts/AllocationChart.tsx";
import { WeeklySummary } from "./WeeklySummary.tsx";
import { getAllocation, getReturns, getValueSeries } from "../server/portfolio.ts";

const Stat = ({
  label,
  value,
  tone,
  note,
}: {
  label: string;
  value: string;
  tone?: "gain" | "loss";
  note?: string;
}) => (
  <div className="card">
    <div className="text-sm text-muted">{label}</div>
    <div
      className={`font-mono tabular-nums text-2xl ${
        tone === "gain" ? "text-gain" : tone === "loss" ? "text-loss" : ""
      }`}
    >
      {value}
    </div>
    {note && <p className="mt-1 text-xs text-muted">{note}</p>}
  </div>
);

export const DashboardPage = () => {
  const series = useQuery({
    queryKey: ["value-series"],
    queryFn: () => getValueSeries({ data: {} }),
  });
  const returns = useQuery({
    queryKey: ["returns"],
    queryFn: () => getReturns({ data: {} }),
  });
  const allocation = useQuery({
    queryKey: ["allocation", "kind"],
    queryFn: () => getAllocation({ data: { by: "kind" } }),
  });

  if (series.isError || returns.isError || allocation.isError) {
    return (
      <p role="alert" className="text-loss">
        Could not load the data. Try refreshing the page.
      </p>
    );
  }
  if (series.isPending || returns.isPending || allocation.isPending) return <p>Loading…</p>;

  // "No current holdings" is not "never invested": a fully divested user still has a real
  // chart and returns. Only a series that was never worth anything gets the empty-state card.
  const hasEverInvested = series.data.some((point) => Number(point.valueEur) !== 0);

  // The last date still marked stale: every earlier day was valued from a carried-forward or
  // missing price. Nordnet funds have no usable historical NAV, so a long stale prefix is expected.
  // Gated on hasEverInvested: a never-invested portfolio's staleness is an import problem.
  const staleFrom = hasEverInvested ? series.data.filter((point) => point.stale).at(-1) : undefined;

  return (
    <>
      <h1>Dashboard</h1>

      <WeeklySummary />

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Stat
          label="Portfolio value"
          value={eur(returns.data.valueWithCashEur)}
          // Cash counts toward value but never toward the returns beside it, so the split is named.
          note={
            returns.data.cashEur === "0.00"
              ? undefined
              : returns.data.lockedCashEur === "0.00"
                ? `investments ${eur(returns.data.valueEur)} + cash ${eur(returns.data.cashEur)}`
                : // A deposit locked until maturity is not spendable money, so it is named separately.
                  `investments ${eur(returns.data.valueEur)} + cash ${eur(
                    returns.data.availableCashEur,
                  )} + locked ${eur(returns.data.lockedCashEur)}`
          }
        />
        <Stat
          label="Return (time-weighted)"
          value={hasEverInvested && returns.data.twr !== null ? pct(returns.data.twr) : "—"}
          tone={
            hasEverInvested && returns.data.twr !== null
              ? returns.data.twr >= 0
                ? "gain"
                : "loss"
              : undefined
          }
          // An excluded holding means the figure is missing a position's value or was computed
          // from a minority of the window; named so "—" or a percentage never reads as clean.
          note={
            returns.data.excludedInstruments.length > 0
              ? `Not fully included: ${returns.data.excludedInstruments
                  .map((i) => i.name)
                  .join(", ")} (price or exchange rate missing for part of the period).`
              : undefined
          }
        />
        <Stat
          label="Money-weighted return (XIRR)"
          value={returns.data.mwr === null ? "—" : pct(returns.data.mwr)}
          tone={returns.data.mwr === null ? undefined : returns.data.mwr >= 0 ? "gain" : "loss"}
          // For an account whose broker exports no deposits (OP), contributions are read from
          // purchases instead, so the figure answers a slightly different question; say so.
          note={
            returns.data.accountsMissingCashRecord.length > 0
              ? `For accounts ${returns.data.accountsMissingCashRecord
                  .map((a) => a.name)
                  .join(
                    ", ",
                  )} the amounts invested are inferred from purchases: the broker does not export deposits.`
              : undefined
          }
        />
      </section>

      {hasEverInvested ? (
        <>
          <section className="card mt-6">
            <h2>Value over time</h2>
            <TimeSeriesChart
              label="Portfolio value"
              points={series.data.map((p) => ({
                date: p.date,
                value: Number(p.valueEur),
                invested: Number(p.investedEur),
                cash: Number(p.cashEur),
                estimated: p.costValued,
              }))}
            />
            {staleFrom && (
              <p className="mt-2 max-w-prose text-xs text-muted">
                Some values are stale until {formatDate(staleFrom.date)}. Price history for funds
                (e.g. Nordnet) only accumulates from the day the automatic price refresh first ran
                -- before that, the value is based on the last known price, not the actual price of
                the day.
              </p>
            )}
          </section>

          <section className="card mt-6">
            <h2>Allocation</h2>
            <AllocationChart slices={allocation.data.slices} />
            {allocation.data.excludedInstruments.length > 0 && (
              <p className="mt-3 max-w-prose text-xs text-muted">
                Missing from the allocation:{" "}
                {allocation.data.excludedInstruments.map((i) => i.name).join(", ")}. Either a sale
                with no matching purchase, or a missing price or exchange rate. See the Holdings
                page for details.
              </p>
            )}
          </section>
        </>
      ) : (
        <section className="card mt-6">
          <h2>No investments yet</h2>
          <p className="max-w-prose text-muted">
            The portfolio value is €0.00 because there are currently no investments. A cash deposit
            does not show up in the portfolio value by itself -- only purchased instruments count.
            Once you make your first purchase, the value over time and allocation appear on this
            page.
          </p>
        </section>
      )}
    </>
  );
};

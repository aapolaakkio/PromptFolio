import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { eur, formatDateTime } from "../lib/format.ts";
import { getSummary } from "../server/summary.ts";

type Facts = Awaited<ReturnType<typeof getSummary>>["facts"];

const SHOWN_NAMES = 5;
const FIVE_MINUTES_MS = 300_000;

const plural = (count: number, one: string): string => `${count} ${one}${count === 1 ? "" : "s"}`;

const valueLine = (facts: Facts): string => {
  const moved = facts.changeDirection === "flat" ? "unchanged" : facts.changeDirection;
  const amount = eur(facts.changeExcludingDepositsEur.replace(/^-/, ""));
  const pct = facts.changePct === null ? "" : ` (${facts.changePct.replace(/^-/, "")}%)`;
  const estimate = facts.changeIsEstimate
    ? " (estimate: some holdings had no price a week ago)"
    : "";
  const change = moved === "unchanged" ? "unchanged" : `${moved} ${amount}${pct}`;
  return `Portfolio value ${eur(facts.totalValueEur)}, ${change} this week${estimate}.`;
};

const newInstrumentsLine = (facts: Facts): string => {
  const more = facts.newInstrumentCount - Math.min(facts.newInstruments.length, SHOWN_NAMES);
  const names = facts.newInstruments.slice(0, SHOWN_NAMES).join(", ");
  return `New instruments: ${names}${more > 0 ? ` +${more} more` : ""}.`;
};

/** Only what happened or needs the owner: a zero line is noise. */
const factLines = (facts: Facts): string[] =>
  [
    valueLine(facts),
    Number(facts.netDepositsEur) === 0
      ? ""
      : `Paid in (net) ${eur(facts.netDepositsEur)}, not counted as growth.`,
    ...facts.movers.map((mover) => `${mover.name}: ${eur(mover.changeEur)} (${mover.changePct}%).`),
    facts.importsMade > 0 ? `${plural(facts.importsMade, "import")} made.` : "",
    facts.newInstrumentCount > 0 ? newInstrumentsLine(facts) : "",
    ...facts.needsAttention.map((item) => `${item.name}: ${item.reason}.`),
    facts.uncategorisedRows > 0
      ? `${plural(facts.uncategorisedRows, "uncategorised spending row")}.`
      : "",
    `Spending this week ${eur(facts.spendingThisWeekEur)}; weekly average over the last quarter ${eur(facts.spendingWeeklyAverageEur)}.`,
    facts.recurringChanged > 0
      ? `${plural(facts.recurringChanged, "recurring payment")} changed amount.`
      : "",
    facts.yearlyFundCostEur === null ? "" : `Yearly fund costs ${eur(facts.yearlyFundCostEur)}.`,
  ].filter((line) => line !== "");

export const WeeklySummary = () => {
  const client = useQueryClient();
  const summary = useQuery({
    queryKey: ["weekly-summary"],
    queryFn: () => getSummary({ data: {} }),
    // A load may spend a model call: do not repeat it on every focus.
    staleTime: FIVE_MINUTES_MS,
    refetchOnWindowFocus: false,
  });
  const refresh = useMutation({
    mutationFn: () => getSummary({ data: { refresh: true } }),
    onSuccess: (fresh) => client.setQueryData(["weekly-summary"], fresh),
  });

  // The note is a courtesy: it never blocks or breaks the dashboard.
  if (summary.isPending || summary.isError) return null;
  const { text, facts, canRefresh, retryAt } = summary.data;
  const tryAgain = retryAt !== null && retryAt <= Date.now();

  return (
    <section className="card mb-6" aria-label="This week">
      <h2>This week</h2>
      {text === null ? (
        <p className="text-sm text-muted">
          Summary text unavailable — showing the facts.{" "}
          {tryAgain ? (
            <button
              type="button"
              className="quiet-button p-0 text-accent"
              disabled={summary.isFetching}
              onClick={() => void summary.refetch()}
            >
              Try again
            </button>
          ) : (
            retryAt !== null &&
            `The next try is possible at ${formatDateTime(new Date(retryAt).toISOString())}.`
          )}
        </p>
      ) : (
        <p className="max-w-prose whitespace-pre-line">{text}</p>
      )}
      <details className="mt-2" open={text === null}>
        <summary className="text-sm text-muted">Details</summary>
        <ul className="fact-list mt-2 max-w-prose text-sm">
          {factLines(facts).map((line, index) => (
            <li key={index}>{line}</li>
          ))}
        </ul>
      </details>
      {refresh.isError && (
        <p role="alert" className="mt-2 text-sm text-loss">
          Could not refresh the summary. Try again later.
        </p>
      )}
      {canRefresh && (
        <button
          type="button"
          className="quiet-button mt-2 text-sm text-accent"
          disabled={refresh.isPending}
          onClick={() => refresh.mutate()}
        >
          Refresh
        </button>
      )}
    </section>
  );
};

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { eur } from "../lib/format.ts";
import { getSummary } from "../server/summary.ts";

type Facts = Awaited<ReturnType<typeof getSummary>>["facts"];

/** Only what happened or needs the owner: a zero line is noise. */
const factLines = (facts: Facts): string[] =>
  [
    `Portfolio value ${eur(facts.totalValueEur)}, ${facts.changeEur.startsWith("-") ? "down" : "up"} ${eur(
      facts.changeEur.replace(/^-/, ""),
    )}${facts.changePct === null ? "" : ` (${facts.changePct}%)`} over the last ${facts.windowDays} days.`,
    ...facts.movers.map((mover) => `${mover.name}: ${eur(mover.changeEur)} (${mover.changePct}%).`),
    facts.importsMade > 0 ? `${facts.importsMade} import(s) made.` : "",
    facts.newInstruments.length > 0 ? `New instruments: ${facts.newInstruments.join(", ")}.` : "",
    ...facts.needsAttention.map((item) => `${item.name}: ${item.reason}.`),
    facts.uncategorisedRows > 0 ? `${facts.uncategorisedRows} uncategorised spending rows.` : "",
    `Spending this week ${eur(facts.spendingThisWeekEur)}; weekly average over the last ${facts.baselineWeeks} weeks ${eur(facts.spendingWeeklyAverageEur)}.`,
    facts.recurringChanged > 0
      ? `${facts.recurringChanged} recurring payment(s) changed amount.`
      : "",
    facts.yearlyFundCostEur === null ? "" : `Yearly fund costs ${eur(facts.yearlyFundCostEur)}.`,
  ].filter((line) => line !== "");

export const WeeklySummary = () => {
  const client = useQueryClient();
  const summary = useQuery({
    queryKey: ["weekly-summary"],
    queryFn: () => getSummary({ data: {} }),
  });
  const refresh = useMutation({
    mutationFn: () => getSummary({ data: { refresh: true } }),
    onSuccess: (fresh) => client.setQueryData(["weekly-summary"], fresh),
  });

  // The note is a courtesy: it never blocks or breaks the dashboard.
  if (summary.isPending || summary.isError) return null;
  const { text, facts, canRefresh } = summary.data;

  return (
    <section className="card mb-6" aria-label="This week">
      <h2>This week</h2>
      {text !== null && <p className="max-w-prose whitespace-pre-line">{text}</p>}
      <details className="mt-2" open={text === null}>
        <summary className="text-sm text-muted">Details</summary>
        <ul className="mt-2 max-w-prose list-disc pl-5 text-sm">
          {factLines(facts).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </details>
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

import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { apiGet } from "../lib/api";
import { eur, pct, fiDate } from "../lib/format";
import { TimeSeriesChart } from "../charts/TimeSeriesChart";
import { AllocationChart, type AllocationSlice } from "../charts/AllocationChart";

/**
 * Response schemas for the three endpoints this page calls, parsed
 * instead of the `as T` cast `apiGet` otherwise falls back to (spec
 * §9.2's "validate at every boundary" -- a server response-shape change
 * now produces a loud, descriptive `ZodError` here instead of silently
 * wrong numbers on the dashboard). `apiGet`'s type parameter is inferred
 * FROM each schema (no separately declared `ValuePoint`/`Returns` type to
 * drift out of sync with it); `AllocationSlice` is imported from
 * AllocationChart.tsx (it also describes `<AllocationChart
 * slices={...} />`'s prop shape), so its schema instead carries an
 * explicit `z.ZodType<AllocationSlice>` annotation -- TypeScript rejects
 * this file if the two shapes disagree.
 */
const ValuePointSchema = z.object({ date: z.string(), valueEur: z.string(), stale: z.boolean() });

const ReturnsSchema = z.object({
  valueEur: z.string(),
  stale: z.boolean(),
  twr: z.number(),
  mwr: z.number().nullable(),
  from: z.string(),
  to: z.string(),
});

const AllocationSliceSchema: z.ZodType<AllocationSlice> = z.object({
  key: z.string(),
  label: z.string(),
  valueEur: z.string(),
  weight: z.number(),
});

const Stat = ({ label, value, tone }: { label: string; value: string; tone?: "gain" | "loss" }) => (
  <div className="card">
    <div className="text-sm text-muted">{label}</div>
    <div
      className={`font-mono tabular-nums text-2xl ${
        tone === "gain" ? "text-gain" : tone === "loss" ? "text-loss" : ""
      }`}
    >
      {value}
    </div>
  </div>
);

export const DashboardPage = () => {
  const series = useQuery({
    queryKey: ["value-series"],
    queryFn: () => apiGet("/api/value-series", z.array(ValuePointSchema)),
  });
  const returns = useQuery({
    queryKey: ["returns"],
    queryFn: () => apiGet("/api/returns", ReturnsSchema),
  });
  const allocation = useQuery({
    queryKey: ["allocation", "kind"],
    queryFn: () => apiGet("/api/allocation?by=kind", z.array(AllocationSliceSchema)),
  });

  if (series.isError || returns.isError || allocation.isError) {
    return (
      <p role="alert" className="text-loss">
        Tietojen haku epäonnistui. Yritä päivittää sivu.
      </p>
    );
  }
  if (series.isPending || returns.isPending || allocation.isPending) return <p>Ladataan…</p>;

  // Portfolio value is positions x price x FX (spec §7) -- a deposit that
  // hasn't been invested in anything never shows up here, by design. But
  // "no current holdings" (empty allocation, today) is NOT the same claim
  // as "never invested a cent" -- a fully divested user who once held
  // positions still has a real chart and real returns, and telling them
  // otherwise would be a confidently wrong statement about their own
  // history. `hasEverInvested` asks the value series itself: has the
  // portfolio ever actually been worth something? Only when the answer is
  // no do we show the explanatory empty-state card instead of the normal
  // dashboard. `allocation.data` (today's holdings) still separately
  // decides what the allocation section shows -- empty there just means
  // "nothing held right now", which `AllocationChart` already renders as
  // "Ei omistuksia", a true statement for a divested portfolio too.
  const hasEverInvested = series.data.some((point) => Number(point.valueEur) !== 0);

  // The last date still marked stale in the series (see valueSeries in
  // core/returns.ts): every earlier day was valued from a carried-forward
  // or missing price. For Nordnet funds specifically, the historical NAV
  // endpoint needs a browser session the scraper doesn't have -- real
  // accumulation only starts the day the price-refresh job first runs, so
  // a long stale prefix here is expected, not a bug. Gated on
  // `hasEverInvested` too: a portfolio that never held anything can only
  // ever be stale in the degenerate case of a position bought but never
  // once priced, which is an import/instrument problem, not a "some
  // values are old" one -- showing this badge above the "no investments
  // yet" card would be a non-sequitur, so it stays with the real dashboard.
  const staleFrom = hasEverInvested ? series.data.filter((point) => point.stale).at(-1) : undefined;

  return (
    <>
      <h1>Yleiskuva</h1>

      {staleFrom && (
        <div className="mb-6">
          <span className="inline-block rounded-full border border-line px-3 py-1 text-xs text-muted">
            Osa arvoista vanhentuneita {fiDate(staleFrom.date)} asti
          </span>
          <p className="mt-1 max-w-prose text-xs text-muted">
            Rahastojen (esim. Nordnet) hintahistoria kertyy vasta siitä päivästä alkaen, kun
            automaattinen hintapäivitys ensi kerran ajettiin -- sitä ennen arvo perustuu
            viimeisimpään tunnettuun hintaan, ei todelliseen päivän hintaan.
          </p>
        </div>
      )}

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Stat label="Salkun arvo" value={eur(returns.data.valueEur)} />
        <Stat
          label="Tuotto (aikapainotettu)"
          value={hasEverInvested ? pct(returns.data.twr) : "—"}
          tone={hasEverInvested ? (returns.data.twr >= 0 ? "gain" : "loss") : undefined}
        />
        <Stat
          label="Oma tuotto (XIRR)"
          value={returns.data.mwr === null ? "—" : pct(returns.data.mwr)}
          tone={returns.data.mwr === null ? undefined : returns.data.mwr >= 0 ? "gain" : "loss"}
        />
      </section>

      {hasEverInvested ? (
        <>
          <section className="card mt-6">
            <h2>Arvon kehitys</h2>
            <TimeSeriesChart
              label="Salkun arvo"
              points={series.data.map((p) => ({ date: p.date, value: Number(p.valueEur) }))}
            />
          </section>

          <section className="card mt-6">
            <h2>Jakauma</h2>
            <AllocationChart slices={allocation.data} />
          </section>
        </>
      ) : (
        <section className="card mt-6">
          <h2>Ei vielä sijoituksia</h2>
          <p className="max-w-prose text-muted">
            Salkun arvo on 0,00 €, koska sijoituksia ei tällä hetkellä ole. Käteinen talletus ei
            itsessään näy salkun arvossa -- vain ostetut arvopaperit vaikuttavat siihen. Kun teet
            ensimmäisen ostotapahtuman, arvon kehitys ja jakauma näkyvät tällä sivulla.
          </p>
        </section>
      )}
    </>
  );
};

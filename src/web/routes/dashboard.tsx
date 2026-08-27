import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../lib/api";
import { eur, pct, fiDate } from "../lib/format";
import { TimeSeriesChart } from "../charts/TimeSeriesChart";
import { AllocationChart, type AllocationSlice } from "../charts/AllocationChart";

type ValuePoint = { date: string; valueEur: string; stale: boolean };
type Returns = {
  valueEur: string;
  stale: boolean;
  twr: number;
  mwr: number | null;
  from: string;
  to: string;
};

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
    queryFn: () => apiGet<ValuePoint[]>("/api/value-series"),
  });
  const returns = useQuery({
    queryKey: ["returns"],
    queryFn: () => apiGet<Returns>("/api/returns"),
  });
  const allocation = useQuery({
    queryKey: ["allocation", "kind"],
    queryFn: () => apiGet<AllocationSlice[]>("/api/allocation?by=kind"),
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
  // hasn't been invested in anything never shows up here, by design. An
  // empty allocation is the one client-visible signal for "no current
  // positions": treat it as the empty/cash-only state and explain the
  // zero, rather than showing a bare "0,00 €" that reads as broken.
  const hasPositions = allocation.data.length > 0;

  // The last date still marked stale in the series (see valueSeries in
  // core/returns.ts): every earlier day was valued from a carried-forward
  // or missing price. For Nordnet funds specifically, the historical NAV
  // endpoint needs a browser session the scraper doesn't have -- real
  // accumulation only starts the day the price-refresh job first runs, so
  // a long stale prefix here is expected, not a bug.
  const staleFrom = series.data.filter((p) => p.stale).at(-1);

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
          value={hasPositions ? pct(returns.data.twr) : "—"}
          tone={hasPositions ? (returns.data.twr >= 0 ? "gain" : "loss") : undefined}
        />
        <Stat
          label="Oma tuotto (XIRR)"
          value={returns.data.mwr === null ? "—" : pct(returns.data.mwr)}
          tone={returns.data.mwr === null ? undefined : returns.data.mwr >= 0 ? "gain" : "loss"}
        />
      </section>

      {hasPositions ? (
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

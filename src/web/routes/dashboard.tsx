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
  /** Positions only -- what twr and mwr below are computed from. */
  valueEur: z.string(),
  /** Uninvested cash, and the two added together (spec 10c/C2). */
  cashEur: z.string(),
  availableCashEur: z.string(),
  lockedCashEur: z.string(),
  valueWithCashEur: z.string(),
  stale: z.boolean(),
  // `null` (like `mwr`) is a real, distinct answer -- C5: at least half the value
  // series' sub-periods were corrupted by an instrument `/api/value-series` could
  // not honestly value (see core/returns.ts's `twr` doc for why that beats a
  // confident wrong percentage). `excludedInstruments` below names which holding.
  twr: z.number().nullable(),
  mwr: z.number().nullable(),
  from: z.string(),
  to: z.string(),
  excludedInstruments: z.array(
    // Null for an instrument no registry carries -- a delisted share, or a
    // temporary line from a corporate action (see instruments.isin). Rejecting
    // it here failed the whole dashboard query, which the UI could only report
    // as a generic "could not load".
    z.object({ instrumentId: z.number(), isin: z.string().nullable(), name: z.string() }),
  ),
  /** Accounts whose contributions are inferred from purchases -- see the note below. */
  accountsMissingCashRecord: z.array(z.object({ accountId: z.number(), name: z.string() })),
});

const AllocationSliceSchema: z.ZodType<AllocationSlice> = z.object({
  key: z.string(),
  label: z.string(),
  valueEur: z.string(),
  weight: z.number(),
});

/**
 * `/api/allocation` returns an envelope, not a bare array: `slices` is what
 * `AllocationChart` renders, and `excludedInstruments` names every instrument
 * left out of every slice's total, for either of two reasons: a SELL with no
 * matching earlier BUY drives a position negative (a negative position must
 * never be counted into an allocation total), or the holding could not be
 * priced/converted to EUR for the requested date (no price, or no fx rate --
 * see `core/allocation.ts`'s `allocateBy`). Neither is silently dropped with
 * no trace. Each entry's `instrumentId` is the same id `/api/holdings` reports
 * that same instrument's `costBasisError`/`valuationError` under.
 */
const AllocationResponseSchema = z.object({
  slices: z.array(AllocationSliceSchema),
  excludedInstruments: z.array(
    // Null for an instrument no registry carries -- a delisted share, or a
    // temporary line from a corporate action (see instruments.isin). Rejecting
    // it here failed the whole dashboard query, which the UI could only report
    // as a generic "could not load".
    z.object({ instrumentId: z.number(), isin: z.string().nullable(), name: z.string() }),
  ),
});

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
    queryFn: () => apiGet("/api/value-series", z.array(ValuePointSchema)),
  });
  const returns = useQuery({
    queryKey: ["returns"],
    queryFn: () => apiGet("/api/returns", ReturnsSchema),
  });
  const allocation = useQuery({
    queryKey: ["allocation", "kind"],
    queryFn: () => apiGet("/api/allocation?by=kind", AllocationResponseSchema),
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
        <Stat
          label="Salkun arvo"
          value={eur(returns.data.valueWithCashEur)}
          // Cash counts toward value but never toward the returns beside it
          // (spec 10c/C2), so the split is named rather than left to be guessed.
          note={
            returns.data.cashEur === "0.00"
              ? undefined
              : returns.data.lockedCashEur === "0.00"
                ? `sijoitukset ${eur(returns.data.valueEur)} + käteinen ${eur(returns.data.cashEur)}`
                : // A deposit locked until its maturity is not spendable money,
                  // so the split is named rather than folded into one figure.
                  `sijoitukset ${eur(returns.data.valueEur)} + käteinen ${eur(
                    returns.data.availableCashEur,
                  )} + sidottu ${eur(returns.data.lockedCashEur)}`
          }
        />
        <Stat
          label="Tuotto (aikapainotettu)"
          value={hasEverInvested && returns.data.twr !== null ? pct(returns.data.twr) : "—"}
          tone={
            hasEverInvested && returns.data.twr !== null
              ? returns.data.twr >= 0
                ? "gain"
                : "loss"
              : undefined
          }
          // C5: an excluded holding always means the figure above is either missing a
          // real position's value (from's/to's own valueEur) or was computed from a
          // minority of the requested window (twr === null, see core/returns.ts's
          // `twr` doc) -- named here so "—" or a percentage never reads as clean when
          // it is not, mirroring the allocation section's own "Jakaumasta puuttuu" note.
          note={
            returns.data.excludedInstruments.length > 0
              ? `Ei sisällä täysin: ${returns.data.excludedInstruments
                  .map((i) => i.name)
                  .join(", ")} (hinta tai valuuttakurssi puuttuu osalta ajanjaksoa).`
              : undefined
          }
        />
        <Stat
          label="Oma tuotto (XIRR)"
          value={returns.data.mwr === null ? "—" : pct(returns.data.mwr)}
          tone={returns.data.mwr === null ? undefined : returns.data.mwr >= 0 ? "gain" : "loss"}
          // Said out loud rather than left implicit: for an account whose broker
          // exports no deposits (OP's transaction view), contributions are read
          // from purchases instead, so this figure answers a slightly different
          // question there. Quietly choosing a definition is what let this show
          // roughly three times the true annual rate.
          note={
            returns.data.accountsMissingCashRecord.length > 0
              ? `Tilien ${returns.data.accountsMissingCashRecord
                  .map((a) => a.name)
                  .join(
                    ", ",
                  )} sijoitetut summat on päätelty ostoista: välittäjä ei vie talletuksia.`
              : undefined
          }
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
            <AllocationChart slices={allocation.data.slices} />
            {allocation.data.excludedInstruments.length > 0 && (
              <p className="mt-3 max-w-prose text-xs text-muted">
                Jakaumasta puuttuu:{" "}
                {allocation.data.excludedInstruments.map((i) => i.name).join(", ")}. Syynä on joko
                myynti ilman vastaavaa ostoa tai puuttuva hinta/valuuttakurssi. Katso tarkemmat
                tiedot Omistukset-sivulta.
              </p>
            )}
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

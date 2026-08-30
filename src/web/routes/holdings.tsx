import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet } from "../lib/api.ts";
import { eur, qty, share, fiDate } from "../lib/format.ts";
import { sortHoldings, type Holding, type SortDirection, type SortKey } from "./holdings-sort.ts";
import { HoldingsChart } from "../charts/HoldingsChart.tsx";
import { RecordPriceForm } from "./RecordPriceForm.tsx";
import { getHoldings } from "../server/portfolio.ts";

export type { Holding };

const KIND_LABELS = {
  stock: "Osake",
  etf: "ETF",
  fund: "Rahasto",
  cash: "Käteinen",
} satisfies Record<Holding["kind"], string>;

/**
 * The price/staleness column has to read correctly for two distinct real
 * cases (a plain "stale" boolean would blur them together):
 *  - priced, but later than it should be: `priceDate` is a real past date and
 *    `stale` is true. "Later than it should be" is not "not today" -- see
 *    `core/staleness.ts`: at the weekend nothing traded, and a fund's NAV
 *    publishes a weekday behind, so neither earns the badge.
 *  - never priced at all, or priced but not convertible to EUR (no fx rate
 *    for today): `priceDate` may be a real date or `null`, `stale` is
 *    always true, and the market-value/gain cells render "tuntematon"
 *    (see below) rather than any number -- the API never fabricates a
 *    0,00 € for a holding it cannot value.
 * Both states are conveyed through text ("vanha" / "ei hintaa"), not colour
 * alone, so the distinction survives for colour-blind users and in print.
 */
const PriceCell = ({ priceDate, stale }: { priceDate: string | null; stale: boolean }) => {
  if (priceDate === null) {
    return (
      <span className="rounded-full border border-line px-2 py-0.5 text-xs text-muted">
        ei hintaa
      </span>
    );
  }
  return (
    <>
      {fiDate(priceDate)}
      {stale && (
        <span className="ml-2 rounded-full border border-line px-2 py-0.5 text-xs text-muted">
          vanha
        </span>
      )}
    </>
  );
};

/**
 * The third state alongside `PriceCell`'s "priced, but not today" and "never
 * priced": cost basis, market value and unrealised gain are not stale and not
 * zero, they are genuinely unknown -- a SELL on the ledger has no matching
 * earlier BUY (typically one page of a multi-page OP import pasted out of
 * order, with the purchase on a page not yet imported). Rendered the same way
 * as `PriceCell`'s badges (a short label, full explanation on hover/focus via
 * `title`) so all three "not a plain number" states read consistently rather
 * than one being an error-red banner and the others a quiet badge.
 */
const UnknownCostCell = ({ message }: { message: string }) => (
  <span className="rounded-full border border-line px-2 py-0.5 text-xs text-muted" title={message}>
    tuntematon
  </span>
);

export const HoldingsPage = () => {
  const queryClient = useQueryClient();
  const [sortKey, setSortKey] = useState<SortKey>("valueEur");
  const [direction, setDirection] = useState<SortDirection>("desc");
  // Which row (by instrumentId) currently shows its inline "enter a price"
  // form -- closing the "manual price source has no way to enter a price"
  // gap. Not restricted to instruments whose priceSource is "manual": a
  // human correcting any instrument's stale/wrong stored price needs the
  // exact same entry path, see RecordPriceForm.tsx's own doc comment.
  const [priceFormFor, setPriceFormFor] = useState<number | null>(null);

  const holdings = useQuery({
    queryKey: ["holdings"],
    queryFn: () => getHoldings({ data: {} }),
  });

  const rows = useMemo(
    () => (holdings.data ? sortHoldings(holdings.data, sortKey, direction) : []),
    [holdings.data, sortKey, direction],
  );

  const toggle = (key: SortKey) => {
    if (key === sortKey) {
      setDirection(direction === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setDirection(key === "name" ? "asc" : "desc");
    }
  };

  if (holdings.isError) {
    return (
      <p role="alert" className="text-loss">
        Omistusten haku epäonnistui. Yritä päivittää sivu.
      </p>
    );
  }
  if (holdings.isPending) return <p>Ladataan…</p>;

  if (rows.length === 0) {
    return (
      <>
        <h1>Omistukset</h1>
        <p className="text-muted">Ei omistuksia. Aloita tuomalla CSV-tiedosto Tuonnit-sivulta.</p>
      </>
    );
  }

  const header = (key: SortKey, label: string, numeric = true) => {
    const active = sortKey === key;
    return (
      <th className={numeric ? "num" : undefined}>
        <button
          type="button"
          className="header-button"
          onClick={() => toggle(key)}
          aria-sort={active ? (direction === "asc" ? "ascending" : "descending") : "none"}
        >
          {label}
          {active ? (direction === "asc" ? " ↑" : " ↓") : ""}
        </button>
      </th>
    );
  };

  return (
    <>
      <h1>Omistukset</h1>
      {/* Above the table, because the one question the table makes you work
          for -- how much rides on a single position -- is answered by the
          lengths at a glance. */}
      <section className="mb-6">
        <HoldingsChart holdings={rows} />
      </section>
      <table>
        <thead>
          <tr>
            {header("name", "Arvopaperi", false)}
            <th>Laji</th>
            <th>Valuutta</th>
            {header("quantity", "Määrä")}
            {header("costEur", "Hankintameno")}
            {header("valueEur", "Markkina-arvo")}
            {header("unrealisedEur", "Tuotto")}
            {header("weight", "Paino")}
            <th>Hinta</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.instrumentId}>
              <td>
                {row.name}
                <div className="text-xs text-muted">{row.isin}</div>
              </td>
              <td>{KIND_LABELS[row.kind]}</td>
              <td>{row.currency}</td>
              <td className="num">{qty(row.quantity)}</td>
              <td className="num">
                {row.costEur === null ? (
                  // SAFETY: costEur/costBasisError are null together (see
                  // Holding's own docs); the `?? ""` fallback only guards a
                  // shape TypeScript itself cannot correlate across fields.
                  <UnknownCostCell message={row.costBasisError?.message ?? ""} />
                ) : (
                  eur(row.costEur)
                )}
              </td>
              <td className="num">
                {row.valueEur === null ? (
                  // valueEur/unrealisedEur can be null for either of two independent
                  // reasons (see Holding's own docs): an unmatched-disposal cost basis
                  // (costBasisError) or a valuation failure -- no price or no fx rate
                  // for today (valuationError). Whichever is set explains this cell.
                  <UnknownCostCell
                    message={row.costBasisError?.message ?? row.valuationError ?? ""}
                  />
                ) : (
                  eur(row.valueEur)
                )}
              </td>
              <td
                className={`num ${
                  row.unrealisedEur === null
                    ? ""
                    : Number(row.unrealisedEur) >= 0
                      ? "text-gain"
                      : "text-loss"
                }`}
              >
                {row.unrealisedEur === null ? (
                  <UnknownCostCell
                    message={row.costBasisError?.message ?? row.valuationError ?? ""}
                  />
                ) : (
                  eur(row.unrealisedEur)
                )}
              </td>
              <td className="num">
                {row.weight === null ? (
                  // weight is null in exactly the same cases valueEur is (see
                  // Holding's own doc) -- the same explanation applies here.
                  <UnknownCostCell
                    message={row.costBasisError?.message ?? row.valuationError ?? ""}
                  />
                ) : (
                  share(row.weight)
                )}
              </td>
              <td className="num">
                <PriceCell priceDate={row.priceDate} stale={row.stale} />
                <div>
                  <button
                    type="button"
                    className="mt-1 text-xs"
                    onClick={() =>
                      setPriceFormFor(priceFormFor === row.instrumentId ? null : row.instrumentId)
                    }
                  >
                    {priceFormFor === row.instrumentId ? "Peruuta" : "Syötä hinta"}
                  </button>
                  {priceFormFor === row.instrumentId && (
                    <RecordPriceForm
                      instrumentId={row.instrumentId}
                      currency={row.currency}
                      onRecorded={() => {
                        setPriceFormFor(null);
                        void queryClient.invalidateQueries({ queryKey: ["holdings"] });
                      }}
                    />
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
};

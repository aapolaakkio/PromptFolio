import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../lib/api";
import { eur, qty, fiDate } from "../lib/format";
import { sortHoldings, type Holding, type SortDirection, type SortKey } from "./holdings-sort";

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
 *  - priced, but not today: `priceDate` is a real past date and `stale` is
 *    true. Normal for Nordnet funds, whose price history only starts
 *    accumulating once the refresh job first runs (spec §10a A5) -- so a
 *    long stale prefix is expected, not an error.
 *  - never priced at all: `priceDate` is `null`. The API values the
 *    position at 0,00 € and marks it stale too, but a user must not read
 *    "0,00 €, old price" here -- there is no price yet, at all.
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
  const [sortKey, setSortKey] = useState<SortKey>("valueEur");
  const [direction, setDirection] = useState<SortDirection>("desc");

  const holdings = useQuery({
    queryKey: ["holdings"],
    queryFn: () => apiGet<Holding[]>("/api/holdings"),
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
                  <UnknownCostCell message={row.costBasisError?.message ?? ""} />
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
                  <UnknownCostCell message={row.costBasisError?.message ?? ""} />
                ) : (
                  eur(row.unrealisedEur)
                )}
              </td>
              <td className="num">
                <PriceCell priceDate={row.priceDate} stale={row.stale} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
};

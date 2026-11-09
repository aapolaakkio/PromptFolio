import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { eur, qty, share, formatDate } from "../lib/format.ts";
import { yearlyCostSummary } from "../../core/fund-costs.ts";
import { chargeLabel, instrumentLabel } from "./holdings-label.ts";
import { sortHoldings, type Holding, type SortDirection, type SortKey } from "./holdings-sort.ts";
import { HoldingsChart } from "../charts/HoldingsChart.tsx";
import { RecordPriceForm } from "./RecordPriceForm.tsx";
import { EditInstrumentForm } from "./EditInstrumentForm.tsx";
import { Modal } from "./Modal.tsx";
import { getHoldings } from "../server/portfolio.ts";
import { refreshPricesNow } from "../server/prices.ts";

const KIND_LABELS = {
  stock: "Share",
  etf: "ETF",
  fund: "Fund",
  cash: "Cash",
} satisfies Record<Holding["kind"], string>;

/** Price column: stale (later than it should be) or never priced/not convertible (always stale; value cells say "unknown"). Conveyed through text, not colour alone. */
const PriceCell = ({ priceDate, stale }: { priceDate: string | null; stale: boolean }) => {
  if (priceDate === null) {
    return (
      <span className="rounded-full border border-line px-2 py-0.5 text-xs text-muted">
        no price
      </span>
    );
  }
  return (
    <>
      {formatDate(priceDate)}
      {stale && (
        <span className="ml-2 rounded-full border border-line px-2 py-0.5 text-xs text-muted">
          stale
        </span>
      )}
    </>
  );
};

/** Cost basis, value and gain can be unknown (e.g. a SELL with no earlier BUY); shown as a badge with the explanation in `title`. */
const UnknownCostCell = ({ message }: { message: string }) => (
  <span className="rounded-full border border-line px-2 py-0.5 text-xs text-muted" title={message}>
    unknown
  </span>
);

/** The yearly total of fund fees: "unknown" until at least one fee is known, and how many funds it covers. */
const FeeSummary = ({ rows }: { rows: readonly Holding[] }) => {
  const summary = yearlyCostSummary(
    rows.filter((row) => row.kind === "fund" || row.kind === "etf"),
  );
  if (summary.total === 0) return null;
  return (
    <p className="mb-2 text-sm text-muted">
      Fund fees:{" "}
      {summary.totalEur === null
        ? "unknown"
        : `${eur(summary.totalEur)} per year (${summary.known} of ${summary.total} funds known)`}
    </p>
  );
};

/** The percentage links to the page the fee was read from; an owner's own value says so. */
const FeeCell = ({ row }: { row: Holding }) => {
  const label = chargeLabel(row.ongoingChargeBp);
  const source = row.chargeSource;
  if (source?.url != null) {
    return (
      <a href={source.url} target="_blank" rel="noreferrer noopener" className="text-accent">
        {label}
      </a>
    );
  }
  return (
    <>
      {label}
      {source?.source === "user" && <div className="text-xs text-muted">set by you</div>}
    </>
  );
};

export const HoldingsPage = () => {
  const queryClient = useQueryClient();
  const [sortKey, setSortKey] = useState<SortKey>("valueEur");
  const [direction, setDirection] = useState<SortDirection>("desc");
  // The holding whose price form is open; any instrument's stored price can be corrected.
  const [priceFormFor, setPriceFormFor] = useState<number | null>(null);
  /** The holding whose "correct how this is priced" form is open. */
  const [editFor, setEditFor] = useState<number | null>(null);

  const holdings = useQuery({
    queryKey: ["holdings"],
    queryFn: () => getHoldings({ data: {} }),
  });

  const rows = useMemo(
    () => (holdings.data ? sortHoldings(holdings.data, sortKey, direction) : []),
    [holdings.data, sortKey, direction],
  );
  const editing = rows.find((row) => row.instrumentId === editFor);
  const pricing = rows.find((row) => row.instrumentId === priceFormFor);

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
        Could not load holdings. Try refreshing the page.
      </p>
    );
  }
  if (holdings.isPending) return <p>Loading…</p>;

  if (rows.length === 0) {
    return (
      <>
        <h1>Holdings</h1>
        <p className="text-muted">
          No holdings. Start by importing a CSV file on the Imports page.
        </p>
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
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1>Holdings</h1>
        <RefreshPricesButton />
      </div>
      <section className="mb-6">
        <HoldingsChart holdings={rows} />
      </section>
      <FeeSummary rows={rows} />
      <table>
        <thead>
          <tr>
            {header("name", "Instrument", false)}
            <th>Kind</th>
            <th>Currency</th>
            {header("quantity", "Quantity")}
            {header("costEur", "Cost basis")}
            {header("valueEur", "Market value")}
            {header("unrealisedEur", "Gain")}
            {header("weight", "Weight")}
            <th className="num">Fee</th>
            <th>Price</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.instrumentId}>
              <td>
                {row.name}
                <div className="text-xs text-muted">{instrumentLabel(row)}</div>
              </td>
              <td>{KIND_LABELS[row.kind]}</td>
              <td>{row.currency}</td>
              <td className="num">{qty(row.quantity)}</td>
              <td className="num">
                {row.costEur === null ? (
                  // SAFETY: costEur/costBasisError are null together; `?? ""` only satisfies the types.
                  <UnknownCostCell message={row.costBasisError?.message ?? ""} />
                ) : (
                  eur(row.costEur)
                )}
              </td>
              <td className="num">
                {row.valueEur === null ? (
                  // Null from costBasisError or valuationError; whichever is set explains this cell.
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
                  // weight is null exactly when valueEur is.
                  <UnknownCostCell
                    message={row.costBasisError?.message ?? row.valuationError ?? ""}
                  />
                ) : (
                  share(row.weight)
                )}
              </td>
              <td className="num">
                <FeeCell row={row} />
                {row.yearlyCostEur !== null && (
                  <div className="text-xs text-muted">{eur(row.yearlyCostEur)} / year</div>
                )}
              </td>
              <td className="num">
                <PriceCell priceDate={row.priceDate} stale={row.stale} />
                <div>
                  <button
                    type="button"
                    className="mt-1 text-xs"
                    onClick={() => setPriceFormFor(row.instrumentId)}
                  >
                    Enter price
                  </button>
                  <button
                    type="button"
                    className="mt-1 ml-1 text-xs"
                    onClick={() => setEditFor(row.instrumentId)}
                  >
                    Edit
                  </button>
                  {row.lookupStatus === "attention" && (
                    <span className="ml-1 text-xs text-loss">No price source found</span>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Over the page, not inside the row: an open form no longer pushes the table around. */}
      {editing && (
        <Modal title={`Edit ${editing.name}`} onClose={() => setEditFor(null)}>
          <EditInstrumentForm
            instrumentId={editing.instrumentId}
            feeBp={
              editing.kind === "fund" || editing.kind === "etf"
                ? { value: editing.ongoingChargeBp }
                : undefined
            }
            onSaved={() => {
              setEditFor(null);
              void queryClient.invalidateQueries();
            }}
          />
        </Modal>
      )}
      {pricing && (
        <Modal title={`Enter a price for ${pricing.name}`} onClose={() => setPriceFormFor(null)}>
          <RecordPriceForm
            instrumentId={pricing.instrumentId}
            currency={pricing.currency}
            onRecorded={() => {
              setPriceFormFor(null);
              void queryClient.invalidateQueries({ queryKey: ["holdings"] });
            }}
          />
        </Modal>
      )}
    </>
  );
};

/** Runs the price refresh now (latest prices and missing history; can take a while). */
const RefreshPricesButton = () => {
  const queryClient = useQueryClient();
  const refresh = useMutation({
    mutationFn: () => refreshPricesNow(),
    onSettled: () => void queryClient.invalidateQueries(),
  });
  return (
    <div className="flex items-baseline gap-2">
      {refresh.isError && (
        <span role="alert" className="text-loss text-sm">
          Price refresh failed
        </span>
      )}
      {refresh.isSuccess && <span className="text-muted text-sm">Prices refreshed</span>}
      <button
        type="button"
        className="text-sm"
        disabled={refresh.isPending}
        onClick={() => refresh.mutate()}
      >
        {refresh.isPending ? "Refreshing…" : "Refresh prices"}
      </button>
    </div>
  );
};

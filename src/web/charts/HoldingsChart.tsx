import { useMemo } from "react";
import { barX, defineChart } from "@tanstack/charts";
import { scaleBand } from "@tanstack/charts/scales/band";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { tooltip } from "@tanstack/charts/tooltip";
import { Chart } from "@tanstack/react-charts";

import { eur } from "../lib/format.ts";
import { MARK_FOCUS } from "./interactions.ts";

/** Only what this chart draws, so it does not depend on the whole holdings row. */
export type HoldingBar = {
  readonly instrumentId: number;
  readonly name: string;
  readonly valueEur: string | null;
  readonly unrealisedEur: string | null;
};

export type HoldingRow = {
  readonly name: string;
  readonly value: number;
  readonly gain: number | null;
};

/**
 * The holdings worth drawing, largest first.
 *
 * A holding that could not be valued is left out rather than drawn at zero: a
 * bar of no length says "this is worth nothing", which is a different and false
 * claim. The holdings table names every one of them with its own explanation,
 * so nothing disappears silently.
 */
export const barsFor = (holdings: readonly HoldingBar[]): HoldingRow[] =>
  holdings
    .filter((holding) => holding.valueEur !== null)
    .map((holding) => ({
      name: holding.name,
      value: Number(holding.valueEur),
      gain: holding.unrealisedEur === null ? null : Number(holding.unrealisedEur),
    }))
    .sort((a, b) => b.value - a.value);

/** What a hovered bar says: what it is worth, and what of that is gain or loss. */
export const holdingTip = (row: HoldingRow): string =>
  row.gain === null
    ? `${row.name}: ${eur(String(row.value))}`
    : `${row.name}: ${eur(String(row.value))} (${row.gain >= 0 ? "+" : ""}${eur(String(row.gain))})`;

/**
 * Every holding as a bar, longest first, coloured by whether it is up or down.
 *
 * Answers the one question the holdings table makes you work for: how much of
 * the portfolio rides on a single position. A table sorted by value tells you
 * the order; only the lengths tell you that the top one is half of everything.
 *
 * Gain and loss are the app's own semantic colours rather than two series
 * hues -- this is polarity, not identity, and the two greens beside a red would
 * read as three unrelated categories.
 */
export const HoldingsChart = ({ holdings }: { holdings: readonly HoldingBar[] }) => {
  const rows = useMemo(() => barsFor(holdings), [holdings]);

  const definition = useMemo(
    () =>
      defineChart({
        marks: [
          barX(rows, {
            x: "value",
            y: "name",
            radius: 4,
            inset: 1,
            fill: (row: HoldingRow) =>
              row.gain === null || row.gain >= 0 ? "var(--color-gain)" : "var(--color-loss)",
          }),
        ],
        scales: {
          x: {
            scale: scaleLinear,
            nice: true,
            grid: true,
            axis: { ticks: { count: 4, format: (value: number) => eur(String(value)) } },
          },
          y: { scale: () => scaleBand<string>().padding(0.25) },
        },
        ...MARK_FOCUS,
        tooltip: { use: tooltip, format: (point) => holdingTip(point.datum) },
      }),
    [rows],
  );

  if (rows.length === 0) return <p className="text-muted">Ei arvotettavia omistuksia.</p>;

  return (
    <div style={{ height: `${Math.max(120, rows.length * 34)}px` }}>
      <Chart definition={definition} ariaLabel="Omistukset arvon mukaan" />
    </div>
  );
};

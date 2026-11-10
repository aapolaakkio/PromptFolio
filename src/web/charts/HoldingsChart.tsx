import { useMemo } from "react";
import { barX, defineChart } from "@tanstack/charts";
import { scaleBand } from "@tanstack/charts/scales/band";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { tooltip } from "@tanstack/charts/tooltip";
import { Chart } from "@tanstack/react-charts";

import { eur } from "../lib/format.ts";
import { ChartFrame } from "./ChartFrame.tsx";
import { MARK_FOCUS } from "./interactions.ts";

/** Only what this chart draws, so it does not depend on the whole holdings row. */
type HoldingBar = {
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

/** Holdings worth drawing, largest first; an unvalued one is left out (a zero bar would claim it is worth nothing) and the table explains it. */
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

/** Every holding as a bar, coloured up or down: shows how much rides on one position. Gain/loss use semantic colours (polarity, not identity). */
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

  if (rows.length === 0) return <p className="text-muted">No priced holdings.</p>;

  return (
    <ChartFrame title="Holdings by value">
      {/* `height` sizes the chart: react-charts 1.x does not measure the surrounding box. */}
      <Chart
        definition={definition}
        height={Math.max(120, rows.length * 34)}
        ariaLabel="Holdings by value"
      />
    </ChartFrame>
  );
};

import { useMemo } from "react";
import { barX, defineChart, stack } from "@tanstack/charts";
import { scaleBand } from "@tanstack/charts/scales/band";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { scaleOrdinal } from "@tanstack/charts/scales/ordinal";
import { Chart } from "@tanstack/react-charts";

import { eur } from "../lib/format.ts";
import { colourFor, SERIES_COUNT } from "./palette.ts";

/** Shape of `allocationView` rows; `valueEur` is a decimal string. */
type AllocationSlice = {
  key: string;
  label: string;
  valueEur: string;
  weight: number;
};

/** Beyond eight slices the tail folds into one "Other": nine hues are not separable. */
const grouped = (slices: readonly AllocationSlice[]): AllocationSlice[] => {
  if (slices.length <= SERIES_COUNT) return [...slices];
  const shown = slices.slice(0, SERIES_COUNT - 1);
  const rest = slices.slice(SERIES_COUNT - 1);
  const restMinor = rest.reduce((sum, slice) => sum + Math.round(Number(slice.valueEur) * 100), 0);
  return [
    ...shown,
    {
      key: "other",
      label: `Other (${rest.length})`,
      valueEur: (restMinor / 100).toFixed(2),
      weight: rest.reduce((sum, slice) => sum + slice.weight, 0),
    },
  ];
};

/** One stacked bar, not a pie: lengths read more accurately than angles. */
/** Exported so a test can build it: `defineChart` throws on a bad scale only at mount. */
const allocationDefinition = (shown: readonly AllocationSlice[]) =>
  defineChart({
    marks: [
      barX(
        shown.map((slice) => ({
          band: "osuus",
          label: slice.label,
          share: slice.weight * 100,
          valueEur: slice.valueEur,
        })),
        {
          x: "share",
          y: "band",
          color: "label",
          layout: stack(),
          radius: 4,
          // A surface gap so adjacent slices read as two.
          inset: 1,
        },
      ),
    ],
    scales: {
      x: { scale: scaleLinear, domain: [0, 100] },
      y: { scale: () => scaleBand<string>() },
    },
    // `color` is a sibling of `scales`: positional scales are reserved ids.
    color: {
      scale: scaleOrdinal<string, string>()
        .domain(shown.map((slice) => slice.label))
        .range(shown.map((_slice, index) => colourFor(index))),
    },
    guides: false,
    // No tooltip: the legend already shows name, euro figure and share.
  });

export const AllocationChart = ({ slices }: { slices: AllocationSlice[] }) => {
  const shown = useMemo(() => grouped(slices), [slices]);
  const definition = useMemo(() => allocationDefinition(shown), [shown]);

  if (slices.length === 0) return <p className="text-muted">No holdings.</p>;

  return (
    <div>
      <div className="h-10">
        <Chart
          height={40}
          definition={definition}
          ariaLabel="Allocation"
          aspectRatio={30 / 1}
          initialWidth={640}
        />
      </div>
      <ul className="mt-4 grid list-none gap-1.5 p-0">
        {shown.map((slice, index) => (
          <li key={slice.key} className="flex items-center gap-2.5">
            <span
              className="size-2.5 flex-none rounded-sm"
              // Data-driven, so this one stays inline.
              style={{ background: colourFor(index) }}
            />
            <span className="flex-1">{slice.label}</span>
            <span className="num">{eur(slice.valueEur)}</span>
            <span className="num w-18 text-muted">{(slice.weight * 100).toFixed(1)} %</span>
          </li>
        ))}
      </ul>
    </div>
  );
};

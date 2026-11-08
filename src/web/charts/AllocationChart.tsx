import { useMemo } from "react";
import { barX, defineChart, stack } from "@tanstack/charts";
import { scaleBand } from "@tanstack/charts/scales/band";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { scaleOrdinal } from "@tanstack/charts/scales/ordinal";
import { Chart } from "@tanstack/react-charts";

import { eur } from "../lib/format.ts";
import { colourFor, SERIES_COUNT } from "./palette.ts";

/**
 * Matches `allocationView`'s actual shape (`src/server/views/portfolio.ts`):
 * `key` (a stable id -- kind code, currency code, account id or instrument id),
 * `label` (the Finnish display name) and `valueEur` (a decimal string, never `value`).
 */
export type AllocationSlice = {
  key: string;
  label: string;
  valueEur: string;
  weight: number;
};

/**
 * Beyond eight slices colour stops carrying identity -- a reader cannot hold
 * nine hues apart, and an invented ninth is never as separable as the eight
 * that were validated. The tail folds into one "Muu" slice, which is honest
 * about being a group rather than pretending to be a holding.
 */
const grouped = (slices: readonly AllocationSlice[]): AllocationSlice[] => {
  if (slices.length <= SERIES_COUNT) return [...slices];
  const shown = slices.slice(0, SERIES_COUNT - 1);
  const rest = slices.slice(SERIES_COUNT - 1);
  const restMinor = rest.reduce((sum, slice) => sum + Math.round(Number(slice.valueEur) * 100), 0);
  return [
    ...shown,
    {
      key: "muu",
      label: `Muu (${rest.length})`,
      valueEur: (restMinor / 100).toFixed(2),
      weight: rest.reduce((sum, slice) => sum + slice.weight, 0),
    },
  ];
};

/**
 * One stacked bar: each holding's share of the whole, drawn as length.
 *
 * Deliberately not a pie -- people read lengths far more accurately than
 * angles, and a part-to-whole with three to eight parts is exactly where a
 * single stacked bar wins. The legend beneath carries each slice's own euro
 * figure and share, so identity never rests on colour alone and the same
 * numbers are readable without hovering anything.
 */
/**
 * Built outside the component so a test can construct it.
 *
 * `defineChart` validates at run time -- a colour scale placed among the
 * positional ones throws "Position scales cannot use reserved ID" only when the
 * chart mounts, which no type check and no test of a React component's props
 * would catch. Exporting the builder makes that a unit test.
 */
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
          // A gap of surface between segments, so two adjacent fills read
          // as two slices rather than one.
          inset: 1,
        },
      ),
    ],
    scales: {
      x: { scale: scaleLinear, domain: [0, 100] },
      y: { scale: () => scaleBand<string>() },
    },
    // `color` is a sibling of `scales`, not one of them: the positional
    // scales are reserved ids, and putting a colour scale among them is a
    // runtime error rather than a type one.
    color: {
      scale: scaleOrdinal<string, string>()
        .domain(shown.map((slice) => slice.label))
        .range(shown.map((_slice, index) => colourFor(index))),
    },
    guides: false,
    // No tooltip: the legend under the bar already gives every slice its name,
    // its euro figure and its share, in a form that can be read without a
    // pointer and copied out of the page. A tooltip here would repeat what is
    // already on screen, and hide it behind a hover.
  });

export const AllocationChart = ({ slices }: { slices: AllocationSlice[] }) => {
  const shown = useMemo(() => grouped(slices), [slices]);
  const definition = useMemo(() => allocationDefinition(shown), [shown]);

  if (slices.length === 0) return <p className="text-muted">Ei omistuksia.</p>;

  return (
    <div>
      <div className="h-10">
        <Chart
          height={40}
          definition={definition}
          ariaLabel="Jakauma"
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

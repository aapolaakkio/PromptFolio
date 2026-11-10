import { useMemo } from "react";
import { defineChart, link, rect, text } from "@tanstack/charts";
import { sankeyDiagram, type SankeyLink, type SankeyNode } from "@tanstack/charts/network/sankey";
import { tooltip } from "@tanstack/charts/tooltip";
import { Chart } from "@tanstack/react-charts";

import type { FlowLink, FlowNode } from "../../server/spending/cashflow.ts";
import { eur } from "../lib/format.ts";
import { ChartFrame } from "./ChartFrame.tsx";
import { bumpX } from "./curve.ts";
import { MARK_FOCUS } from "./interactions.ts";
import { colourFor } from "./palette.ts";

/** Income sources label left, everything downstream right, so a label never sits on its own ribbons. */
const labelsOnLeft = (id: string): boolean => id.startsWith("in:") || id === "income";

/** Server-computed euro figure, formatted with `eur()` so it matches the tables. */
const labelFor = (node: FlowNode): string => `${node.label}: ${eur(node.totalEur)}`;

/** The row shape this file feeds the diagram, once a value is attached. */
type FlowRow = FlowLink & { readonly value: number };

/** What a hovered mark says. Reads the laid-out `kind` objects (`sourceNode`/`targetNode`), not the input rows. */
const describe = (
  datum: SankeyLink<FlowNode, FlowRow, string> | SankeyNode<FlowNode, FlowRow, string>,
): string =>
  datum.kind === "link"
    ? `${datum.sourceNode.data.label} → ${datum.targetNode.data.label}: ${eur(datum.data.amountEur)}`
    : `${datum.data.label}: ${eur(datum.data.totalEur)}`;

/** A Sankey of one period: widths come from the server sums, so it cannot disagree with the table. */
export const CashFlowChart = ({
  nodes,
  links,
}: {
  readonly nodes: readonly FlowNode[];
  readonly links: readonly FlowLink[];
}) => {
  const definition = useMemo(() => {
    const colourOf = new Map(nodes.map((node, index) => [node.id, colourFor(index)]));

    return defineChart({
      marks: [
        sankeyDiagram({
          nodes: [...nodes],
          links: links.map((flow) => ({ ...flow, value: Number(flow.amountEur) })),
          nodeKey: "id",
          source: "from",
          target: "to",
          value: "value",
          align: "justify",
          nodeWidth: ({ width }) => Math.max(8, width * 0.008),
          // Generous gaps: thin ribbons at the bottom are unreadable when touching.
          nodePadding: ({ height }) => Math.max(10, height * 0.022),
          iterations: 24,
          inset: { top: 12, bottom: 12, left: 150, right: 190 },
          marks: ({ nodes: laidOut, links: ribbons }) =>
            [
              link(ribbons, {
                x1: "x1",
                y1: "y1",
                x2: "x2",
                y2: "y2",
                key: "key",
                // S-bend: a straight diagonal crosses neighbouring ribbons.
                curve: bumpX,
                strokeWidth: (flow) => Math.max(1, flow.width),
                stroke: (flow) => colourOf.get(flow.targetNode.data.id) ?? colourFor(0),
                // Sheer enough that overlapping ribbons stay separable.
                strokeOpacity: 0.55,
                lineCap: "butt",
              }),
              // One rect mark per node: `fill` is mark-level.
              ...laidOut.map((node) =>
                rect([node], {
                  x1: "x0",
                  x2: "x1",
                  y1: "y0",
                  y2: "y1",
                  key: "key",
                  fill: colourOf.get(node.data.id) ?? colourFor(0),
                  inset: 0,
                }),
              ),
              // Two passes: the anchor is a mark-level option.
              text(
                laidOut.filter((node) => labelsOnLeft(node.data.id)),
                {
                  x: "x0",
                  y: "y",
                  key: "key",
                  text: (node) => labelFor(node.data),
                  anchor: "end",
                  dx: -8,
                  fontSize: 12,
                },
              ),
              text(
                laidOut.filter((node) => !labelsOnLeft(node.data.id)),
                {
                  x: "x1",
                  y: "y",
                  key: "key",
                  text: (node) => labelFor(node.data),
                  anchor: "start",
                  dx: 8,
                  fontSize: 12,
                },
              ),
            ] as const,
        }),
      ],
      scales: { x: null, y: null },
      guides: false,
      // Ribbons carry no label, so hover is the only way to read a flow; without a format the tooltip prints geometry.
      ...MARK_FOCUS,
      tooltip: {
        use: tooltip,
        format: (point) => describe(point.datum),
      },
    });
  }, [nodes, links]);

  if (nodes.length === 0) {
    return <p className="text-muted">No cash flows in this period.</p>;
  }

  return (
    <ChartFrame title="Cash flows">
      <div className="h-128">
        <Chart
          definition={definition}
          height={512}
          ariaLabel="Cash flows: income, spending and investments"
        />
      </div>
    </ChartFrame>
  );
};

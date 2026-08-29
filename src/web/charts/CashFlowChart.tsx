import { useMemo } from "react";
import { defineChart, link, rect, text } from "@tanstack/charts";
import { sankeyDiagram } from "@tanstack/charts/network/sankey";
import { Chart } from "@tanstack/react-charts";

import { bumpX } from "./curve";
import { colourFor } from "./palette";

export type FlowNode = { id: string; label: string; totalEur: string };
export type FlowLink = { from: string; to: string; amountEur: string };

/**
 * Which side of the diagram a node's label belongs on.
 *
 * A label sitting on top of its own ribbons is unreadable, so income sources
 * are labelled to their left and everything downstream to its right, with the
 * hub in the middle labelled left as well.
 */
const labelsOnLeft = (id: string): boolean => id.startsWith("in:") || id === "income";

/** The euro figure the server computed, shown beside the label rather than recomputed here. */
const labelFor = (node: FlowNode): string => `${node.label}: ${node.totalEur} €`;

/**
 * A Sankey of one period's money: what came in, and where it went.
 *
 * Widths come from the server's own sums (decimal strings parsed once here for
 * layout only) -- the picture is a view of figures already computed, not a
 * second calculation that could disagree with the table beside it.
 */
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
          // Generous gaps: with two dozen categories the thin ribbons at the
          // bottom are unreadable when they touch.
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
                // The S-bend a flow diagram is read by: a straight diagonal
                // between two stacked columns crosses its neighbours at angles
                // the eye has to untangle.
                curve: bumpX,
                strokeWidth: (flow) => Math.max(1, flow.width),
                stroke: (flow) => colourOf.get(flow.targetNode.data.id) ?? colourFor(0),
                strokeOpacity: 0.4,
                lineCap: "butt",
              }),
              // One rect mark per node, since `fill` is a mark-level colour
              // rather than a per-row channel and each node has its own.
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
              // Two passes rather than one: a label's side decides its anchor,
              // and the anchor is a mark-level option, not a per-row channel.
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
    });
  }, [nodes, links]);

  if (nodes.length === 0) {
    return <p className="text-muted">Ei rahavirtoja tällä jaksolla.</p>;
  }

  return (
    <div className="h-128">
      <Chart definition={definition} ariaLabel="Rahavirrat: tulot, menot ja sijoitukset" />
    </div>
  );
};

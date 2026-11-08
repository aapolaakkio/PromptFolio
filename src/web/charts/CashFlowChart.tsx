import { useMemo } from "react";
import { defineChart, link, rect, text } from "@tanstack/charts";
import { sankeyDiagram, type SankeyLink, type SankeyNode } from "@tanstack/charts/network/sankey";
import { tooltip } from "@tanstack/charts/tooltip";
import { Chart } from "@tanstack/react-charts";

import type { FlowLink, FlowNode } from "../../server/spending/cashflow.ts";
import { eur } from "../lib/format.ts";
import { bumpX } from "./curve.ts";
import { MARK_FOCUS } from "./interactions.ts";
import { colourFor } from "./palette.ts";

/**
 * Which side of the diagram a node's label belongs on.
 *
 * A label sitting on top of its own ribbons is unreadable, so income sources
 * are labelled to their left and everything downstream to its right, with the
 * hub in the middle labelled left as well.
 */
const labelsOnLeft = (id: string): boolean => id.startsWith("in:") || id === "income";

/**
 * The euro figure the server computed, shown beside the label rather than
 * recomputed here -- and formatted through the same `eur()` the tables use, so
 * a figure in the diagram and the same figure in the table beside it read
 * identically. It printed the raw decimal string before, which meant the
 * diagram wrote "1234.5 €" where the table wrote "1 234,50 €".
 */
const labelFor = (node: FlowNode): string => `${node.label}: ${eur(node.totalEur)}`;

/**
 * What a hovered mark is, in words.
 *
 * A ribbon is a flow between two nodes and reads as "from → to: amount"; a node
 * block is a total and reads as its own label. Anything else -- a label, a
 * stray mark -- says nothing rather than printing coordinates.
 */
/** The row shape this file feeds the diagram, once a value is attached. */
type FlowRow = FlowLink & { readonly value: number };

/**
 * What a hovered mark is, in words.
 *
 * The library discriminates the two shapes with `kind`, and both are the
 * *laid-out* objects rather than the rows fed in -- a ribbon carries
 * `sourceNode`/`targetNode`, the same objects the stroke colour is read from.
 * Reading the input rows instead produced "undefined: epäluku €": every field
 * missing, and a NaN formatted as though it were money.
 */
const describe = (
  datum: SankeyLink<FlowNode, FlowRow, string> | SankeyNode<FlowNode, FlowRow, string>,
): string =>
  datum.kind === "link"
    ? `${datum.sourceNode.data.label} → ${datum.targetNode.data.label}: ${eur(datum.data.amountEur)}`
    : `${datum.data.label}: ${eur(datum.data.totalEur)}`;

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
                // Opaque enough to carry its colour, sheer enough that crossing
                // ribbons stay separable where they overlap.
                strokeOpacity: 0.55,
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
      // A ribbon's own figure is not written anywhere on the diagram -- only
      // the nodes carry labels -- so hovering one is the only way to read what
      // a single flow was worth. Without a format of its own the tooltip prints
      // the mark's geometry (x1, y1, key), which is true and unreadable.
      ...MARK_FOCUS,
      tooltip: {
        use: tooltip,
        format: (point) => describe(point.datum),
      },
    });
  }, [nodes, links]);

  if (nodes.length === 0) {
    return <p className="text-muted">Ei rahavirtoja tällä jaksolla.</p>;
  }

  return (
    <div className="h-128">
      <Chart
        definition={definition}
        height={512}
        ariaLabel="Rahavirrat: tulot, menot ja sijoitukset"
      />
    </div>
  );
};

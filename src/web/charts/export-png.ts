import { renderChartImage } from "@tanstack/charts/export";

import {
  legendRows,
  readLegend,
  SWATCH_TEXT_OFFSET,
  SWATCH_WIDTH,
  type PlacedEntry,
} from "./export-model.ts";

const PADDING = 16;
const TITLE_SIZE = 15;
const TITLE_LINE = 28;
const LEGEND_SIZE = 12;
const LEGEND_LINE = 20;
const LEGEND_TOP_GAP = 10;
const SWATCH_HEIGHT = 8;
const REVOKE_DELAY_MS = 1000;

type Look = { readonly surface: string; readonly ink: string; readonly family: string };

const fontOf = (weight: number, size: number, family: string): string =>
  `${weight} ${size}px ${family}`;

const drawLegend = (
  context: CanvasRenderingContext2D,
  rows: readonly PlacedEntry[][],
  top: number,
  ink: string,
): void => {
  rows.forEach((row, index) => {
    const middle = top + index * LEGEND_LINE + LEGEND_LINE / 2;
    for (const { entry, x } of row) {
      context.globalAlpha = entry.opacity;
      context.fillStyle = entry.colour;
      context.fillRect(PADDING + x, middle - SWATCH_HEIGHT / 2, SWATCH_WIDTH, SWATCH_HEIGHT);
      context.globalAlpha = 1;
      context.fillStyle = ink;
      context.fillText(entry.label, PADDING + x + SWATCH_TEXT_OFFSET, middle);
    }
  });
};

const toBlob = (canvas: HTMLCanvasElement): Promise<Blob> =>
  new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob === null) reject(new Error("The browser could not encode the PNG."));
      else resolve(blob);
    }, "image/png");
  });

/** The plot bitmap with the surface behind it, the title above and the frame's HTML legend below. */
const compose = (
  frame: HTMLElement,
  plot: ImageBitmap,
  { title, scale, look }: { readonly title: string; readonly scale: number; readonly look: Look },
): HTMLCanvasElement => {
  const size = { width: plot.width / scale, height: plot.height / scale };
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("The browser gave no canvas to draw on.");
  const legendFont = fontOf(400, LEGEND_SIZE, look.family);
  context.font = legendFont;
  const rows = legendRows(
    readLegend(frame, (swatch: Element) => getComputedStyle(swatch)),
    (label) => context.measureText(label).width,
    size.width,
  );
  const legendHeight = rows.length === 0 ? 0 : LEGEND_TOP_GAP + rows.length * LEGEND_LINE;
  const width = size.width + PADDING * 2;
  const height = PADDING + TITLE_LINE + size.height + legendHeight + PADDING;

  // Sizing resets the context, so every style is set after this.
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  context.scale(scale, scale);
  context.fillStyle = look.surface;
  context.fillRect(0, 0, width, height);
  context.textBaseline = "middle";
  context.fillStyle = look.ink;
  context.font = fontOf(600, TITLE_SIZE, look.family);
  // ponytail: a title wider than the chart is squeezed by `maxWidth`, not wrapped.
  context.fillText(title, PADDING, PADDING + TITLE_SIZE / 2, size.width);
  context.drawImage(plot, PADDING, PADDING + TITLE_LINE, size.width, size.height);
  context.font = legendFont;
  drawLegend(context, rows, PADDING + TITLE_LINE + size.height + LEGEND_TOP_GAP, look.ink);
  return canvas;
};

/**
 * The frame's chart as a PNG in the theme on screen. The plot is the chart library's own export
 * (page colours and fonts inlined, focus layers dropped, a zero-size chart refused); only the title
 * and legend around it are drawn here. Tooltip, brush overlay and the menu are HTML or separate
 * elements, so they are never in it.
 */
export const chartToPng = async (
  frame: HTMLElement,
  { title, scale = 2 }: { readonly title: string; readonly scale?: number },
): Promise<Blob> => {
  const tokens = getComputedStyle(frame);
  const look = {
    surface: tokens.getPropertyValue("--color-surface").trim(),
    ink: tokens.color,
    family: tokens.fontFamily,
  };
  const plot = await createImageBitmap(await renderChartImage(frame, { scale }));
  try {
    return await toBlob(compose(frame, plot, { title, scale, look }));
  } finally {
    plot.close();
  }
};

/** Hands the browser a file to save; the object URL is revoked once the download has had time to start. */
// ponytail: SVG download would be the library's `downloadChartSvg` beside this; not asked for.
export const downloadBlob = (blob: Blob, name: string): void => {
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement("a"), { href: url, download: name });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
};

import {
  inlinePaint,
  legendRows,
  readLegend,
  SWATCH_TEXT_OFFSET,
  SWATCH_WIDTH,
  type PlacedEntry,
} from "./export-model.ts";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
/** The library's main surface; a brush overlay is a second, unclassed `<svg>`. */
const CHART_SVG = "svg.ts-chart";
/** Crosshair, focus rings and brush: what only a pointer puts there. */
const INTERACTIVE_LAYERS =
  '[data-ts-focus-layer], [data-ts-focus-guide-layer], [class*="crosshair"], [class*="brush"]';

const PADDING = 16;
const TITLE_SIZE = 15;
const TITLE_LINE = 28;
const LEGEND_SIZE = 12;
const LEGEND_LINE = 20;
const LEGEND_TOP_GAP = 10;
const SWATCH_HEIGHT = 8;
const REVOKE_DELAY_MS = 1000;

type Size = { readonly width: number; readonly height: number };

/** The chart as a self-contained SVG document, at `scale` times its on-screen pixels. */
const standaloneSvg = (svg: SVGSVGElement, size: Size, scale: number): string => {
  const copy = svg.cloneNode(true);
  if (!(copy instanceof SVGSVGElement)) throw new Error("This chart could not be copied.");
  // Before anything is removed: source and copy are walked in step.
  inlinePaint<Element>(svg, copy, (node) => getComputedStyle(node));
  copy.querySelectorAll(INTERACTIVE_LAYERS).forEach((layer) => layer.remove());
  copy.setAttribute("xmlns", SVG_NAMESPACE);
  copy.setAttribute("width", String(size.width * scale));
  copy.setAttribute("height", String(size.height * scale));
  return new XMLSerializer().serializeToString(copy);
};

const loadImage = (source: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => resolve(image), { once: true });
    image.addEventListener(
      "error",
      () => reject(new Error("The chart could not be drawn as an image.")),
      { once: true },
    );
    image.src = source;
  });

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

/**
 * The frame's chart as a PNG in the theme on screen: surface background, the title above, the
 * chart, and the frame's HTML legend below. Tooltip, crosshair, brush and the menu are left out.
 */
export const chartToPng = async (
  frame: HTMLElement,
  { title, scale = 2 }: { readonly title: string; readonly scale?: number },
): Promise<Blob> => {
  const svg = frame.querySelector<SVGSVGElement>(CHART_SVG);
  if (svg === null) throw new Error("There is no chart here to export.");
  const size = svg.getBoundingClientRect();
  const tokens = getComputedStyle(frame);
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("The browser gave no canvas to draw on.");

  const legendFont = fontOf(400, LEGEND_SIZE, tokens.fontFamily);
  context.font = legendFont;
  const rows = legendRows(
    readLegend(frame, (swatch: Element) => getComputedStyle(swatch)),
    (label) => context.measureText(label).width,
    size.width,
  );
  const legendHeight = rows.length === 0 ? 0 : LEGEND_TOP_GAP + rows.length * LEGEND_LINE;
  const width = size.width + PADDING * 2;
  const height = PADDING + TITLE_LINE + size.height + legendHeight + PADDING;
  const image = await loadImage(
    `data:image/svg+xml;charset=utf-8,${encodeURIComponent(standaloneSvg(svg, size, scale))}`,
  );

  // Sizing resets the context, so every style is set after this.
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  context.scale(scale, scale);
  context.fillStyle = tokens.getPropertyValue("--color-surface").trim();
  context.fillRect(0, 0, width, height);
  context.textBaseline = "middle";
  context.fillStyle = tokens.color;
  context.font = fontOf(600, TITLE_SIZE, tokens.fontFamily);
  // ponytail: a title wider than the chart is squeezed by `maxWidth`, not wrapped.
  context.fillText(title, PADDING, PADDING + TITLE_SIZE / 2, size.width);
  context.drawImage(image, PADDING, PADDING + TITLE_LINE, size.width, size.height);
  context.font = legendFont;
  drawLegend(context, rows, PADDING + TITLE_LINE + size.height + LEGEND_TOP_GAP, tokens.color);
  return toBlob(canvas);
};

/** Hands the browser a file to save; the object URL is revoked once the download has had time to start. */
// ponytail: SVG download would sit beside this (`standaloneSvg` is already the file); not asked for.
export const downloadBlob = (blob: Blob, name: string): void => {
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement("a"), { href: url, download: name });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
};

/** One legend entry as the PNG draws it. */
export type LegendEntry = {
  readonly colour: string;
  readonly label: string;
  readonly opacity: number;
};

type SwatchStyle = {
  readonly backgroundColor: string;
  readonly backgroundImage: string;
  readonly opacity: string;
};

type LegendItem<Swatch> = {
  readonly childNodes: ArrayLike<{ readonly textContent: string | null }>;
  readonly querySelector: (selector: string) => Swatch | null;
};

type LegendRoot<Swatch> = {
  readonly querySelectorAll: (selector: string) => ArrayLike<LegendItem<Swatch>>;
};

/** What a computed style can tell about one property; `getComputedStyle` fits. */
type StyleLookup = { readonly getPropertyValue: (name: string) => string };

/** The part of an element the paint inliner touches; a real `Element` and a test fake both fit. */
type PaintNode<Self> = {
  readonly children: ArrayLike<Self>;
  /** Optional because `Element` only gains it as an HTML or SVG element. */
  readonly style?: { readonly setProperty: (name: string, value: string) => void };
};

export const LEGEND_ITEM = "data-legend-item";

const FALLBACK_SLUG = "chart";
const COMBINING_MARKS = /[̀-ͯ]/g;
const NOT_SLUG = /[^a-z0-9]+/g;
const EDGE_DASHES = /^-+|-+$/g;
const TRANSPARENT = /^(transparent|rgba\(0, 0, 0, 0\))$/;
const COLOUR = /rgba?\([^)]*\)|#[0-9a-f]{3,8}/i;
/** Every property whose value depends on the page's stylesheet, and so is lost once the SVG stands alone. */
const PAINT_PROPERTIES = ["color", "fill", "stroke", "font-family", "font-size", "font-weight"];
const PAINTS = new Set(["fill", "stroke"]);

/** ASCII, lower case, dashes: safe as a file name on every system. */
export const slugOf = (title: string): string => {
  const slug = title
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(NOT_SLUG, "-")
    .replace(EDGE_DASHES, "");
  return slug === "" ? FALLBACK_SLUG : slug;
};

const two = (value: number): string => String(value).padStart(2, "0");

/** The viewer's own calendar day, not UTC's: a file saved at 01:00 carries today's date. */
export const isoDay = (date: Date): string =>
  `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;

export const exportFileName = (title: string, extension: string, today: Date): string =>
  `promptfolio-${slugOf(title)}-${isoDay(today)}.${extension}`;

/** A dashed swatch is a gradient over nothing, so its colour is the gradient's first stop. */
const swatchColour = (style: SwatchStyle): string | null => {
  if (!TRANSPARENT.test(style.backgroundColor)) return style.backgroundColor;
  return COLOUR.exec(style.backgroundImage)?.[0] ?? null;
};

const wordsOf = (item: LegendItem<unknown>): string =>
  Array.from(item.childNodes, (child) => (child.textContent ?? "").trim())
    .filter((text) => text !== "")
    .join(" ");

/** The legend as the page shows it: each marked entry's swatch colour (resolved by the browser) and its words. */
export const readLegend = <Swatch>(
  frame: LegendRoot<Swatch>,
  styleOf: (swatch: Swatch) => SwatchStyle,
): LegendEntry[] =>
  Array.from(frame.querySelectorAll(`[${LEGEND_ITEM}]`)).flatMap((item) => {
    const swatch = item.querySelector("[style]");
    const label = wordsOf(item);
    if (swatch === null || label === "") return [];
    const style = styleOf(swatch);
    const colour = swatchColour(style);
    if (colour === null) return [];
    const opacity = Number(style.opacity);
    return [{ colour, label, opacity: Number.isFinite(opacity) ? opacity : 1 }];
  });

/**
 * Writes each source element's computed paint and font onto its copy, so the copy draws the same
 * once serialised: CSS variables, `currentColor` and `inherit` mean nothing outside the page.
 */
export const inlinePaint = <Node extends PaintNode<Node>>(
  source: Node,
  copy: Node,
  styleOf: (node: Node) => StyleLookup,
): void => {
  const style = styleOf(source);
  const colour = style.getPropertyValue("color");
  for (const property of PAINT_PROPERTIES) {
    const value = style.getPropertyValue(property);
    if (value === "") continue;
    const own = PAINTS.has(property) && value.toLowerCase() === "currentcolor" ? colour : value;
    if (own !== "") copy.style?.setProperty(property, own);
  }
  Array.from(source.children).forEach((child, index) => {
    const twin = copy.children[index];
    if (twin !== undefined) inlinePaint(child, twin, styleOf);
  });
};

export const SWATCH_WIDTH = 16;
const SWATCH_GAP = 6;
/** From an entry's left edge to where its words start. */
export const SWATCH_TEXT_OFFSET = SWATCH_WIDTH + SWATCH_GAP;
const ENTRY_GAP = 16;

export type PlacedEntry = { readonly entry: LegendEntry; readonly x: number };

/** Entries laid left to right, wrapping when the next one would not fit; an entry wider than the row still gets its own. */
export const legendRows = (
  entries: readonly LegendEntry[],
  widthOf: (label: string) => number,
  maxWidth: number,
): PlacedEntry[][] =>
  entries.reduce<PlacedEntry[][]>((rows, entry) => {
    const width = SWATCH_TEXT_OFFSET + widthOf(entry.label);
    const row = rows.at(-1) ?? [];
    const last = row.at(-1);
    const x =
      last === undefined ? 0 : last.x + SWATCH_TEXT_OFFSET + widthOf(last.entry.label) + ENTRY_GAP;
    if (last !== undefined && x + width > maxWidth) return [...rows, [{ entry, x: 0 }]];
    return [...rows.slice(0, -1), [...row, { entry, x }]];
  }, []);

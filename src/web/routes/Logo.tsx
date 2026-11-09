/** A prompt chevron whose cursor line climbs like a chart and ends on a coin. */
const CHEVRON = "M8 11l5 5-5 5";
const CHART = "M15.5 21l4-4.5 3 2.5 4-8";
const COIN = { cx: 26.5, cy: 11, r: 1.6 };

/** A browser tab cannot read the page's CSS variables, so the favicon carries the light theme's dollar green itself. */
export const FAVICON_HREF = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="1" y="1" width="30" height="30" rx="8" fill="#1d7a47"/>` +
    `<g fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">` +
    `<path d="${CHEVRON}"/><path d="${CHART}"/><circle cx="${COIN.cx}" cy="${COIN.cy}" r="${COIN.r}"/></g></svg>`,
)}`;

/** The app's mark in the theme's accent, with the name beside it. */
export const Logo = ({ size = 28 }: { size?: number }) => (
  <span className="inline-flex items-center gap-2 font-semibold tracking-tight">
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect x="1" y="1" width="30" height="30" rx="8" fill="var(--color-accent)" />
      <g
        fill="none"
        stroke="var(--color-on-accent)"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d={CHEVRON} />
        <path d={CHART} />
        <circle {...COIN} />
      </g>
    </svg>
    <span>PromptFolio</span>
  </span>
);

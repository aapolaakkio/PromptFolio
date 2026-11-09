/** The line under a holding's name: where its price comes from. The Currency column shows the currency. */
const pageLabel = (url: string): string =>
  URL.canParse(url) ? `${new URL(url).host}${new URL(url).pathname}` : url;

export const instrumentLabel = (h: {
  isin: string | null;
  sourceKey: string;
  priceSource: string;
  lookupStatus: "ok" | "pending" | "attention";
}): string => {
  const code =
    h.lookupStatus === "pending"
      ? "looking up ticker"
      : h.priceSource === "manual"
        ? "own price"
        : h.priceSource === "page"
          ? pageLabel(h.sourceKey)
          : h.sourceKey;
  return [h.isin, code].filter((part) => part !== null).join(" · ");
};

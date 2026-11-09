/** The line under a holding's name: where its price comes from. The Valuutta column shows the currency. */
export const instrumentLabel = (h: {
  isin: string | null;
  sourceKey: string;
  priceSource: string;
  lookupStatus: "ok" | "pending" | "attention";
}): string => {
  const code =
    h.lookupStatus === "pending"
      ? "haetaan tunnusta"
      : h.priceSource === "manual"
        ? "oma hinta"
        : h.sourceKey;
  return [h.isin, code].filter((part) => part !== null).join(" · ");
};

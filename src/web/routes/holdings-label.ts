/** The line under a holding's name: where its price comes from, in what currency. */
export const instrumentLabel = (h: {
  isin: string | null;
  sourceKey: string;
  priceSource: string;
  currency: string;
  lookupStatus: "ok" | "pending" | "attention";
}): string => {
  const code =
    h.lookupStatus === "pending"
      ? "haetaan tunnusta"
      : h.priceSource === "manual"
        ? "oma hinta"
        : h.sourceKey;
  return [h.isin, code, h.currency].filter((part) => part !== null).join(" · ");
};

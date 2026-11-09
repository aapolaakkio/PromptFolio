import { useEffect, useState } from "react";
import { z } from "zod";
import { errorMessage } from "../lib/errors.ts";
import { formatMoney, money } from "../../core/money.ts";
import type { FetchedPrice } from "../../server/prices/types.ts";
import { createInstrument, lookUpInstrument } from "../server/instruments.ts";

export type PriceSource = "yahoo" | "page" | "manual";

/** Yahoo prices listed shares and many funds (`0P...` symbols); a fund page covers what Yahoo will not serve. */
export const SOURCES = [
  { id: "yahoo", label: "Yahoo (listed shares and funds)" },
  { id: "page", label: "Price page (address)" },
  { id: "manual", label: "I enter the price myself" },
] as const;

export const readPriceLine = (price: FetchedPrice): string =>
  `Price read: ${formatMoney(money(BigInt(price.closeMinor), price.currency))} ${price.currency} (${price.date})`;

const ISIN_PATTERN = /^[A-Z]{2}[A-Z0-9]{9}\d$/;

const KIND_VALUES = ["stock", "etf", "fund"] as const;
type Kind = (typeof KIND_VALUES)[number];
const isKind = (value: string): value is Kind => KIND_VALUES.some((k) => k === value);

const LookupSchema = z.object({
  kind: z.enum(KIND_VALUES).nullable(),
  name: z.string().nullable(),
  priceSource: z.enum(["yahoo", "page"]).nullable(),
  sourceKey: z.string().nullable(),
  isin: z.string().nullable(),
  listingCurrency: z.string().nullable(),
});
type Lookup = z.infer<typeof LookupSchema>;

type LookupState =
  | { readonly status: "loading" }
  | { readonly status: "resolved"; readonly result: Lookup }
  | { readonly status: "unresolved" };

type UnknownInstrumentFormProps = {
  /** null when the broker export carries no ISIN (OP web paste); the form then asks for one. */
  readonly isin: string | null;
  readonly name: string;
  /** Currency of the imported rows, never from a price registry: one ISIN trades in several currencies. */
  readonly rowCurrency: string;
  readonly onResolved: () => void;
};

export const UnknownInstrumentForm = ({
  isin,
  name,
  rowCurrency,
  onResolved,
}: UnknownInstrumentFormProps) => {
  const [isinInput, setIsinInput] = useState(isin ?? "");
  const [kind, setKind] = useState<Kind>("fund");
  const [lookup, setLookup] = useState<LookupState>({ status: "loading" });
  const [currency, setCurrency] = useState(rowCurrency);
  const [priceSource, setPriceSource] = useState<PriceSource>("yahoo");
  const [sourceKey, setSourceKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [readLine, setReadLine] = useState<string | null>(null);

  /** Fills the form from public registries once on mount; a failed lookup leaves it empty. */
  useEffect(() => {
    let cancelled = false;
    lookUpInstrument({ data: { isin, name, currency: rowCurrency } })
      .then((result) => {
        if (cancelled) return;
        if (result.kind === null && result.priceSource === null) {
          setLookup({ status: "unresolved" });
          return;
        }
        setLookup({ status: "resolved", result });
        if (result.kind !== null) setKind(result.kind);
        if (result.priceSource !== null) setPriceSource(result.priceSource);
        if (result.sourceKey !== null) setSourceKey(result.sourceKey);
        if (result.isin !== null) setIsinInput(result.isin);
      })
      .catch(() => {
        if (!cancelled) setLookup({ status: "unresolved" });
      });

    return () => {
      cancelled = true;
    };
  }, [isin, name, rowCurrency]);

  /** The matched listing trades in another currency than the holding (e.g. IE00B4L5Y983: USD London, EUR Amsterdam); the ticker may be the wrong listing. */
  const listingMismatch =
    lookup.status === "resolved" &&
    lookup.result.listingCurrency !== null &&
    lookup.result.listingCurrency !== currency.trim().toUpperCase()
      ? lookup.result.listingCurrency
      : null;

  const submit = async (event: React.SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const saved = await createInstrument({
        data: {
          isin: isinInput.trim() === "" ? undefined : isinInput.trim().toUpperCase(),
          name,
          kind,
          currency: currency.trim().toUpperCase(),
          priceSource,
          sourceKey: sourceKey.trim() === "" ? undefined : sourceKey,
          ticker: priceSource === "yahoo" ? sourceKey : null,
        },
      });
      if (saved.price === null) onResolved();
      else setReadLine(readPriceLine(saved.price));
    } catch (cause) {
      setError(errorMessage(cause, "Could not save"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="card" onSubmit={submit}>
      <strong>{name || isin}</strong>
      {lookup.status === "loading" && (
        <div className="text-xs text-muted">Looking up registries…</div>
      )}
      {lookup.status === "resolved" && (
        <div className="text-xs text-muted">
          Pre-filled automatically
          {lookup.result.name !== null && <> · registry name: {lookup.result.name}</>} · check and
          save.
        </div>
      )}
      {lookup.status === "unresolved" && (
        <div className="text-xs text-muted">
          Nothing found in the registries — fill in the fields yourself.
        </div>
      )}
      {listingMismatch !== null && (
        <p role="alert" className="text-xs text-loss">
          No listing in {currency.toUpperCase()} was found for this instrument — the pre-filled
          source is {listingMismatch}. Prices would then come from a different exchange than the
          holding; check before saving.
        </p>
      )}
      {isin !== null ? (
        <div className="mb-3 font-mono text-xs text-muted">{isin}</div>
      ) : (
        <label className="mb-3 block">
          ISIN
          <input
            value={isinInput}
            required={priceSource !== "manual"}
            pattern={ISIN_PATTERN.source}
            placeholder="e.g. FI0009000681"
            title="12 characters: 2 letters, 9 letters/digits, 1 digit"
            onChange={(e) => setIsinInput(e.target.value)}
          />
          <div className="text-xs text-muted">
            {priceSource === "manual"
              ? "Leave empty if the instrument has no ISIN. It is then identified by name."
              : "This instrument has no ISIN in the OP import -- enter it yourself."}
          </div>
        </label>
      )}
      <label>
        Kind
        <select
          value={kind}
          onChange={(e) => {
            if (isKind(e.target.value)) setKind(e.target.value);
          }}
        >
          <option value="stock">Share</option>
          <option value="etf">ETF</option>
          <option value="fund">Fund</option>
        </select>
      </label>
      <label>
        Currency
        <input
          value={currency}
          required
          maxLength={3}
          pattern="[A-Za-z]{3}"
          title="3-letter ISO 4217 code, e.g. EUR or SEK"
          onChange={(e) => setCurrency(e.target.value)}
        />
      </label>
      <label>
        Price source
        <select
          value={priceSource}
          onChange={(e) => {
            // SAFETY: the options below are exactly the PriceSource union.
            setPriceSource(e.target.value as PriceSource);
          }}
        >
          {SOURCES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Source code
        <input
          value={sourceKey}
          // Not required for a manual instrument: a delisted share has no symbol.
          required={priceSource !== "manual"}
          onChange={(e) => setSourceKey(e.target.value)}
          placeholder={
            priceSource === "yahoo"
              ? "e.g. NOKIA.HE"
              : priceSource === "page"
                ? "https://www.example.com/fund"
                : "fund code"
          }
        />
        {priceSource === "manual" && (
          <div className="text-xs text-muted">
            Leave empty. Prices are entered by hand on the Holdings page.
          </div>
        )}
      </label>
      {error && (
        <p role="alert" className="text-loss text-sm">
          {error}
        </p>
      )}
      {readLine !== null ? (
        <>
          <p role="status" className="text-sm">
            {readLine}
          </p>
          <button type="button" onClick={onResolved}>
            Done
          </button>
        </>
      ) : (
        <button type="submit" disabled={submitting}>
          {submitting ? "Saving…" : "Save instrument"}
        </button>
      )}
    </form>
  );
};

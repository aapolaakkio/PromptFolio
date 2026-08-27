import { useState } from "react";
import { z } from "zod";
import { apiPost, ApiError } from "../lib/api";

const SOURCES = [
  { id: "yahoo", label: "Yahoo (pörssinoteeratut)" },
  { id: "nordnet_fund", label: "Nordnet-rahasto" },
  { id: "op_fund", label: "OP-rahasto" },
  { id: "spankki_fund", label: "S-Pankki-rahasto" },
  { id: "danske_fund", label: "Danske-rahasto" },
  { id: "manual", label: "Syötän arvon itse" },
] as const;

/** Only the fields this form actually reads out of POST /api/instruments's response. */
const CreatedInstrumentSchema = z.object({ id: z.number() });

const ISIN_PATTERN = /^[A-Z]{2}[A-Z0-9]{9}\d$/;

const KIND_VALUES = ["stock", "etf", "fund"] as const;
type Kind = (typeof KIND_VALUES)[number];
/**
 * Narrows a `<select>`'s raw string value to `Kind` without a type
 * assertion: every `<option>` this form renders is one of `KIND_VALUES`, so
 * this only ever returns false for a value the DOM cannot actually produce
 * here -- matching `commit.ts`'s `isTxnType` idiom (`.some((candidate) =>
 * candidate === value)` needs no cast, unlike `.includes`, since comparing
 * two differently-typed strings with `===` is always allowed).
 */
const isKind = (value: string): value is Kind => KIND_VALUES.some((k) => k === value);

export type UnknownInstrumentFormProps = {
  /**
   * `null` for a broker whose export carries no ISIN at all -- OP's
   * web-paste view (spec §10a A3). The instrument still needs a real ISIN
   * to be registered (POST /api/instruments requires one), so this form
   * asks the user to type it in rather than inventing one; when a real
   * ISIN is already known (Nordnet), it is shown read-only instead.
   */
  readonly isin: string | null;
  readonly name: string;
  readonly onResolved: () => void;
};

export const UnknownInstrumentForm = ({ isin, name, onResolved }: UnknownInstrumentFormProps) => {
  const [isinInput, setIsinInput] = useState(isin ?? "");
  const [kind, setKind] = useState<Kind>("fund");
  // Any ISO 4217 code is valid (spec §10a A1 -- the real portfolio holds
  // both EUR and SEK), so this is a plain validated text input, not a
  // closed EUR/USD dropdown that would make a SEK holding unregisterable
  // from this screen.
  const [currency, setCurrency] = useState("EUR");
  const [priceSource, setPriceSource] = useState<string>("yahoo");
  const [sourceKey, setSourceKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await apiPost(
        "/api/instruments",
        {
          isin: isinInput.trim().toUpperCase(),
          name,
          kind,
          currency: currency.trim().toUpperCase(),
          priceSource,
          sourceKey,
          ticker: priceSource === "yahoo" ? sourceKey : null,
        },
        CreatedInstrumentSchema,
      );
      onResolved();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Tallennus epäonnistui");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="card" onSubmit={submit}>
      <strong>{name || isin}</strong>
      {isin !== null ? (
        <div className="mb-3 font-mono text-xs text-muted">{isin}</div>
      ) : (
        <label className="mb-3 block">
          ISIN
          <input
            value={isinInput}
            required
            pattern={ISIN_PATTERN.source}
            placeholder="esim. FI0009000681"
            title="12 merkkiä: 2 kirjainta, 9 kirjainta/numeroa, 1 numero"
            onChange={(e) => setIsinInput(e.target.value)}
          />
          <div className="text-xs text-muted">
            Tällä arvopaperilla ei ole ISIN-tunnusta OP:n tuonnissa -- syötä se itse.
          </div>
        </label>
      )}
      <label>
        Laji
        <select
          value={kind}
          onChange={(e) => {
            if (isKind(e.target.value)) setKind(e.target.value);
          }}
        >
          <option value="stock">Osake</option>
          <option value="etf">ETF</option>
          <option value="fund">Rahasto</option>
        </select>
      </label>
      <label>
        Valuutta
        <input
          value={currency}
          required
          maxLength={3}
          pattern="[A-Za-z]{3}"
          title="3-kirjaiminen ISO 4217 -koodi, esim. EUR tai SEK"
          onChange={(e) => setCurrency(e.target.value)}
        />
      </label>
      <label>
        Hintalähde
        <select value={priceSource} onChange={(e) => setPriceSource(e.target.value)}>
          {SOURCES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Lähdetunnus
        <input
          value={sourceKey}
          required
          onChange={(e) => setSourceKey(e.target.value)}
          placeholder={priceSource === "yahoo" ? "esim. NOKIA.HE" : "rahaston tunnus"}
        />
      </label>
      {error && (
        <p role="alert" className="text-loss text-sm">
          {error}
        </p>
      )}
      <button type="submit" disabled={submitting}>
        {submitting ? "Tallennetaan…" : "Tallenna arvopaperi"}
      </button>
    </form>
  );
};

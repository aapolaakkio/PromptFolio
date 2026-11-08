import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { editInstrument, getInstruments } from "../server/instruments.ts";
import { type PriceSource, SOURCES } from "./UnknownInstrumentForm.tsx";

const isSource = (value: string): value is PriceSource => SOURCES.some((s) => s.id === value);

/**
 * Corrects how a holding is priced: its currency, price source and source code.
 * Prefilled from the instrument as stored, so a correction changes only what
 * the owner touches.
 */
export const EditInstrumentForm = ({
  instrumentId,
  onSaved,
}: {
  readonly instrumentId: number;
  readonly onSaved: () => void;
}) => {
  const instruments = useQuery({ queryKey: ["instruments"], queryFn: () => getInstruments() });
  const stored = instruments.data?.find((instrument) => instrument.id === instrumentId);
  if (stored === undefined) return <p className="text-xs text-muted">Ladataan…</p>;
  return (
    <Fields
      instrumentId={instrumentId}
      currency={stored.currency}
      priceSource={isSource(stored.priceSource) ? stored.priceSource : "manual"}
      sourceKey={stored.sourceKey}
      onSaved={onSaved}
    />
  );
};

const Fields = (props: {
  readonly instrumentId: number;
  readonly currency: string;
  readonly priceSource: PriceSource;
  readonly sourceKey: string;
  readonly onSaved: () => void;
}) => {
  const [currency, setCurrency] = useState(props.currency);
  const [priceSource, setPriceSource] = useState<PriceSource>(props.priceSource);
  const [sourceKey, setSourceKey] = useState(props.sourceKey);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await editInstrument({
        data: {
          id: props.instrumentId,
          currency: currency.trim().toUpperCase(),
          priceSource,
          sourceKey,
        },
      });
      props.onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Tallennus epäonnistui");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="mt-2 grid gap-2 text-left text-xs" onSubmit={(event) => void submit(event)}>
      <label>
        Valuutta
        <input value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value)} />
      </label>
      {currency.trim().toUpperCase() !== props.currency && (
        <p className="text-muted">
          Valuutan vaihto poistaa tallennetut hinnat; ne haetaan uudelleen.
        </p>
      )}
      <label>
        Hintalähde
        <select
          value={priceSource}
          onChange={(e) => {
            if (isSource(e.target.value)) setPriceSource(e.target.value);
          }}
        >
          {SOURCES.map((source) => (
            <option key={source.id} value={source.id}>
              {source.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Lähdetunnus
        <input value={sourceKey} onChange={(e) => setSourceKey(e.target.value)} />
      </label>
      {error !== null && (
        <p role="alert" className="text-loss">
          {error}
        </p>
      )}
      <button type="submit" disabled={saving}>
        {saving ? "Tallennetaan…" : "Tallenna"}
      </button>
    </form>
  );
};

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { errorMessage } from "../lib/errors.ts";
import { editInstrument, getInstruments, setFundCharge } from "../server/instruments.ts";
import { type PriceSource, readPriceLine, SOURCES } from "./UnknownInstrumentForm.tsx";

const isSource = (value: string): value is PriceSource => SOURCES.some((s) => s.id === value);

/** Corrects currency, price source and source code; prefilled from the stored instrument. */
export const EditInstrumentForm = ({
  instrumentId,
  feeBp,
  onSaved,
}: {
  readonly instrumentId: number;
  /** Set for a fund or ETF: the fee field is shown, prefilled from this. */
  readonly feeBp?: { readonly value: number | null };
  readonly onSaved: () => void;
}) => {
  const instruments = useQuery({ queryKey: ["instruments"], queryFn: () => getInstruments() });
  const stored = instruments.data?.find((instrument) => instrument.id === instrumentId);
  if (stored === undefined) return <p className="text-xs text-muted">Loading…</p>;
  return (
    <Fields
      instrumentId={instrumentId}
      currency={stored.currency}
      priceSource={isSource(stored.priceSource) ? stored.priceSource : "manual"}
      sourceKey={stored.sourceKey}
      feeBp={feeBp}
      onSaved={onSaved}
    />
  );
};

const Fields = (props: {
  readonly instrumentId: number;
  readonly currency: string;
  readonly priceSource: PriceSource;
  readonly sourceKey: string;
  readonly feeBp?: { readonly value: number | null };
  readonly onSaved: () => void;
}) => {
  const initialFee = props.feeBp?.value == null ? "" : (props.feeBp.value / 100).toFixed(2);
  const [fee, setFee] = useState(initialFee);
  const [currency, setCurrency] = useState(props.currency);
  const [priceSource, setPriceSource] = useState<PriceSource>(props.priceSource);
  const [sourceKey, setSourceKey] = useState(props.sourceKey);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [readLine, setReadLine] = useState<string | null>(null);

  const submit = async (event: React.SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const saved = await editInstrument({
        data: {
          id: props.instrumentId,
          currency: currency.trim().toUpperCase(),
          priceSource,
          sourceKey,
        },
      });
      if (props.feeBp !== undefined && fee.trim() !== initialFee) {
        await setFundCharge({ data: { id: props.instrumentId, percent: fee } });
      }
      if (saved.price === null) props.onSaved();
      else setReadLine(readPriceLine(saved.price));
    } catch (cause) {
      setError(errorMessage(cause, "Could not save"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="mt-2 grid gap-2 text-left text-xs" onSubmit={(event) => void submit(event)}>
      <label>
        Currency
        <input value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value)} />
      </label>
      {currency.trim().toUpperCase() !== props.currency && (
        <p className="text-muted">
          Changing the currency deletes the stored prices; they are fetched again.
        </p>
      )}
      <label>
        Price source
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
        Source code
        <input value={sourceKey} onChange={(e) => setSourceKey(e.target.value)} />
      </label>
      {props.feeBp !== undefined && (
        <label>
          Yearly fee, % (empty to look it up again)
          <input value={fee} inputMode="decimal" onChange={(e) => setFee(e.target.value)} />
        </label>
      )}
      {error !== null && (
        <p role="alert" className="text-loss">
          {error}
        </p>
      )}
      {readLine !== null ? (
        <>
          <p role="status">{readLine}</p>
          <button type="button" onClick={props.onSaved}>
            Done
          </button>
        </>
      ) : (
        <button type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      )}
    </form>
  );
};

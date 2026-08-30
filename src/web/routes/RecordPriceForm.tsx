import { useState } from "react";
import { savePrice } from "../server/prices.ts";

const today = (): string => new Date().toISOString().slice(0, 10);

export type RecordPriceFormProps = {
  readonly instrumentId: number;
  /** The instrument's own quotation currency, for the field's label only -- never used in arithmetic here. */
  readonly currency: string;
  /**
   * The date to open on. Today, unless a caller knows the date it needs a price
   * for -- the tax screen does, and typing it again from the row above is work
   * the screen can do for the reader.
   */
  readonly defaultDate?: string;
  readonly onRecorded: () => void;
};

export const RecordPriceForm = ({
  instrumentId,
  currency,
  defaultDate,
  onRecorded,
}: RecordPriceFormProps) => {
  const [date, setDate] = useState(defaultDate ?? today());
  const [price, setPrice] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await savePrice({ data: { instrumentId, date, price } });
      setPrice("");
      onRecorded();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Hinnan tallennus epäonnistui");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="card mt-2" onSubmit={submit}>
      <label className="block text-xs">
        Päivä
        <input
          type="date"
          value={date}
          required
          max={today()}
          onChange={(e) => setDate(e.target.value)}
        />
      </label>
      <label className="mt-2 block text-xs">
        Hinta ({currency})
        <input
          value={price}
          required
          inputMode="decimal"
          placeholder="esim. 12,34"
          onChange={(e) => setPrice(e.target.value)}
        />
      </label>
      {error && (
        <p role="alert" className="mt-1 text-loss text-xs">
          {error}
        </p>
      )}
      <button type="submit" className="mt-2 text-xs" disabled={submitting || price.trim() === ""}>
        {submitting ? "Tallennetaan…" : "Tallenna hinta"}
      </button>
    </form>
  );
};

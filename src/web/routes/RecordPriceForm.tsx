import { useState } from "react";
import { z } from "zod";
import { apiPost, ApiError } from "../lib/api";

/**
 * Closing the "manual price source has no way to enter a price" gap
 * (Phase 1 review): `manual` has been selectable as a price source since
 * Task 14, and `MANUAL.fetch()` has always correctly returned nothing, but
 * no route or screen ever wrote a price -- so a `manual` instrument, or any
 * holding no price source covers, could never actually be valued. `POST /api/prices`
 * (src/server/api/prices.ts) is the route; this form is how the holdings
 * screen reaches it, mirroring `UnknownInstrumentForm.tsx`/
 * `CreateAccountForm.tsx`'s own shape (local state, one `apiPost`, a
 * response schema narrowed to only the field this form reads).
 *
 * The price is sent as the raw text the user typed, untouched -- never
 * `Number()`-parsed here. Money crossing the API boundary is always a
 * decimal string (spec §9.2), and a human-typed price doubly so: it is
 * untrusted input, parsed server-side by `core/money`'s own decimal-string
 * parser (`parseMoney`), never by a JS float step this form could
 * introduce on the way there.
 */
const RecordPriceResponseSchema = z.object({ written: z.number() });

const today = (): string => new Date().toISOString().slice(0, 10);

export type RecordPriceFormProps = {
  readonly instrumentId: number;
  /** The instrument's own quotation currency, for the field's label only -- never used in arithmetic here. */
  readonly currency: string;
  readonly onRecorded: () => void;
};

export const RecordPriceForm = ({ instrumentId, currency, onRecorded }: RecordPriceFormProps) => {
  const [date, setDate] = useState(today());
  const [price, setPrice] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await apiPost("/api/prices", { instrumentId, date, price }, RecordPriceResponseSchema);
      setPrice("");
      onRecorded();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Hinnan tallennus epäonnistui");
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

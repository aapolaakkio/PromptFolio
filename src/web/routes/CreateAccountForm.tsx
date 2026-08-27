import { useState } from "react";
import { z } from "zod";
import { apiPost, ApiError } from "../lib/api";

/**
 * Closing the "a fresh install cannot create its first account without
 * `curl`" gap (Phase 1 review): `POST /api/accounts` has existed and worked
 * since Task 9, but no screen ever called it -- `imports.tsx` only rendered
 * a `<select>` over accounts that already existed. This form is that
 * missing entry path, mirroring `UnknownInstrumentForm.tsx`'s own shape
 * (local state, one `apiPost`, a response schema narrowed to only the
 * fields this form reads).
 *
 * **Deliberately create-only.** There is no update, no delete here, and
 * none should be added for symmetry: deleting an account cascades to every
 * transaction on it (`accounts` -> `transactions` is `onDelete: "cascade"`,
 * see db/schema.ts), and destroying an append-only, audit-relevant ledger
 * needs its own confirmation flow, not a button bolted on next to "create".
 * That is a recorded decision for this task, not an oversight.
 */
const BROKERS = [
  { id: "nordnet", label: "Nordnet" },
  { id: "op", label: "OP" },
  { id: "spankki", label: "S-Pankki" },
  { id: "danske", label: "Danske" },
  { id: "other", label: "Muu" },
] as const;

const BROKER_VALUES = BROKERS.map((b) => b.id);
type Broker = (typeof BROKER_VALUES)[number];
/**
 * Narrows a `<select>`'s raw string value to `Broker` without a type
 * assertion -- every `<option>` this form renders is one of `BROKER_VALUES`,
 * matching `UnknownInstrumentForm.tsx`'s `isKind` idiom.
 */
const isBroker = (value: string): value is Broker => BROKER_VALUES.some((b) => b === value);

/** Only the fields this form actually reads out of POST /api/accounts's response. */
const CreatedAccountSchema = z.object({ id: z.number(), name: z.string() });
export type CreatedAccount = z.infer<typeof CreatedAccountSchema>;

export type CreateAccountFormProps = {
  readonly onCreated: (account: CreatedAccount) => void;
};

export const CreateAccountForm = ({ onCreated }: CreateAccountFormProps) => {
  const [name, setName] = useState("");
  const [broker, setBroker] = useState<Broker>("nordnet");
  // Any ISO 4217 code is valid (spec §10a A1 -- the real portfolio holds
  // both EUR and SEK), so this is a plain validated text input, not a
  // closed EUR/USD dropdown -- mirrors UnknownInstrumentForm.tsx's currency
  // field exactly.
  const [baseCurrency, setBaseCurrency] = useState("EUR");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const created = await apiPost(
        "/api/accounts",
        { name: name.trim(), broker, baseCurrency: baseCurrency.trim().toUpperCase() },
        CreatedAccountSchema,
      );
      setName("");
      setBroker("nordnet");
      setBaseCurrency("EUR");
      onCreated(created);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : "Tilin luonti epäonnistui");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="card mt-3" onSubmit={submit}>
      <label>
        Tilin nimi
        <input
          value={name}
          required
          maxLength={100}
          placeholder="esim. Nordnet AOT"
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label>
        Välittäjä
        <select
          value={broker}
          onChange={(e) => {
            if (isBroker(e.target.value)) setBroker(e.target.value);
          }}
        >
          {BROKERS.map((b) => (
            <option key={b.id} value={b.id}>
              {b.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Perusvaluutta
        <input
          value={baseCurrency}
          required
          maxLength={3}
          pattern="[A-Za-z]{3}"
          title="3-kirjaiminen ISO 4217 -koodi, esim. EUR tai SEK"
          onChange={(e) => setBaseCurrency(e.target.value)}
        />
      </label>
      {error && (
        <p role="alert" className="text-loss text-sm">
          {error}
        </p>
      )}
      <button type="submit" disabled={submitting || name.trim() === ""}>
        {submitting ? "Luodaan…" : "Luo tili"}
      </button>
    </form>
  );
};

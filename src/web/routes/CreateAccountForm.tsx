import { useState } from "react";
import { errorMessage } from "../lib/errors.ts";
import { createAccount } from "../server/accounts.ts";
import { z } from "zod";

import {
  ACCOUNT_KINDS,
  isAccountKind,
  isAccountType,
  typesFor,
  UNSET_LABEL,
  type AccountKind,
  type AccountType,
} from "./account-type.ts";

/** Create-only: deleting an account cascades to its ledger, which needs its own confirmation flow. */
const BROKERS = [
  { id: "nordnet", label: "Nordnet" },
  { id: "op", label: "OP" },
  { id: "spankki", label: "S-Pankki" },
  { id: "danske", label: "Danske" },
  { id: "other", label: "Other" },
] as const;

const BROKER_VALUES = BROKERS.map((b) => b.id);
type Broker = (typeof BROKER_VALUES)[number];
/** Narrows a `<select>`'s raw string value to `Broker` without a type assertion. */
const isBroker = (value: string): value is Broker => BROKER_VALUES.some((b) => b === value);

/** Only the fields this form actually reads out of POST /api/accounts's response. */
const CreatedAccountSchema = z.object({ id: z.number(), name: z.string() });
type CreatedAccount = z.infer<typeof CreatedAccountSchema>;

type CreateAccountFormProps = {
  readonly onCreated: (account: CreatedAccount) => void;
};

export const CreateAccountForm = ({ onCreated }: CreateAccountFormProps) => {
  const [name, setName] = useState("");
  const [broker, setBroker] = useState<Broker>("nordnet");
  const [kind, setKind] = useState<AccountKind>("brokerage");
  // Starts unset on purpose: a guessed OST is worse than a blank type (see account-type.ts).
  const [accountType, setAccountType] = useState<AccountType | "">("");
  const [baseCurrency, setBaseCurrency] = useState("EUR");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: React.SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    const chosenType = accountType === "" ? null : accountType;
    try {
      // Type omitted rather than "": unclassified is stored as null.
      const created = await createAccount({
        data:
          chosenType === null
            ? { name: name.trim(), broker, kind, baseCurrency: baseCurrency.trim().toUpperCase() }
            : {
                name: name.trim(),
                broker,
                kind,
                baseCurrency: baseCurrency.trim().toUpperCase(),
                accountType: chosenType,
              },
      });
      setName("");
      setBroker("nordnet");
      setBaseCurrency("EUR");
      onCreated(created);
    } catch (cause) {
      setError(errorMessage(cause, "Could not create the account"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="card mt-3" onSubmit={submit}>
      <label>
        Account name
        <input
          value={name}
          required
          maxLength={100}
          placeholder="e.g. Nordnet AOT"
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label>
        Broker
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
        Account kind
        <select
          value={kind}
          onChange={(e) => {
            if (!isAccountKind(e.target.value)) return;
            setKind(e.target.value);
            // The other kind's types mean nothing here; clear the choice.
            setAccountType("");
          }}
        >
          {ACCOUNT_KINDS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Account type
        <select
          value={accountType}
          onChange={(e) => {
            setAccountType(isAccountType(e.target.value) ? e.target.value : "");
          }}
        >
          <option value="">{UNSET_LABEL}</option>
          {typesFor(kind).map((type) => (
            <option key={type.id} value={type.id}>
              {type.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Base currency
        <input
          value={baseCurrency}
          required
          maxLength={3}
          pattern="[A-Za-z]{3}"
          title="3-letter ISO 4217 code, e.g. EUR or SEK"
          onChange={(e) => setBaseCurrency(e.target.value)}
        />
      </label>
      {error && (
        <p role="alert" className="text-loss text-sm">
          {error}
        </p>
      )}
      <button type="submit" disabled={submitting || name.trim() === ""}>
        {submitting ? "Creating…" : "Create account"}
      </button>
    </form>
  );
};

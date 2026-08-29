import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";

import { ApiError, apiPatch } from "../lib/api";
import {
  isAccountType,
  toSelection,
  typesFor,
  UNSET_LABEL,
  type AccountKind,
  type AccountType,
} from "./account-type";

const UpdatedSchema = z.object({
  id: z.number(),
  name: z.string(),
  accountType: z.enum(["aot", "ost", "other"]).nullable(),
});

/**
 * Edits an account's name and its type. Not its broker or base currency: those
 * are facts the stored transactions were already interpreted under, so changing
 * either after rows exist would silently reinterpret them. The type is
 * different -- nothing has been interpreted under it yet, and it must stay
 * correctable, since a frozen wrong type is how a tax report goes wrong.
 */
export const RenameAccount = ({
  accountId,
  currentName,
  currentType,
  kind,
}: {
  readonly accountId: number;
  readonly currentName: string;
  readonly currentType: string | null;
  /** Fixed at creation: only this kind's own types are offered. */
  readonly kind: AccountKind;
}) => {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(currentName);
  const [accountType, setAccountType] = useState<AccountType | "">(toSelection(currentType));
  const [error, setError] = useState<string | null>(null);

  const rename = useMutation({
    mutationFn: () =>
      apiPatch(
        `/api/accounts/${accountId}`,
        { name: name.trim(), accountType: accountType === "" ? null : accountType },
        UpdatedSchema,
      ),
    onSuccess: () => {
      setError(null);
      setOpen(false);
      void queryClient.invalidateQueries({ queryKey: ["accounts"] });
    },
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : "Nimen muutos epäonnistui");
    },
  });

  if (!open) {
    return (
      <button
        type="button"
        className="mt-3 text-sm"
        onClick={() => {
          setName(currentName);
          setAccountType(toSelection(currentType));
          setOpen(true);
        }}
      >
        Muokkaa tiliä
      </button>
    );
  }

  return (
    <form
      className="mt-3 flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        rename.mutate();
      }}
    >
      <label>
        Tilin nimi
        <input value={name} required maxLength={100} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        Tilin laji
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
      <button type="submit" className="text-sm" disabled={rename.isPending || name.trim() === ""}>
        {rename.isPending ? "Tallennetaan…" : "Tallenna"}
      </button>
      <button type="button" className="text-sm" onClick={() => setOpen(false)}>
        Peruuta
      </button>
      {error && (
        <p role="alert" className="text-loss w-full text-sm">
          {error}
        </p>
      )}
    </form>
  );
};

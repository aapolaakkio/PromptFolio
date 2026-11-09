import { useState } from "react";
import { errorMessage } from "../lib/errors.ts";
import { editAccount } from "../server/accounts.ts";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  isAccountType,
  toSelection,
  typesFor,
  UNSET_LABEL,
  type AccountKind,
  type AccountType,
} from "./account-type.ts";

/** Edits name and type, not broker or currency (stored rows were interpreted under those); the type stays correctable since a wrong one breaks tax reports. */
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
      editAccount({
        data: {
          id: accountId,
          changes: { name: name.trim(), accountType: accountType === "" ? null : accountType },
        },
      }),
    onSuccess: () => {
      setError(null);
      setOpen(false);
      void queryClient.invalidateQueries({ queryKey: ["accounts"] });
    },
    onError: (cause) => {
      setError(errorMessage(cause, "Could not rename the account"));
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
        Edit account
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
        Account name
        <input value={name} required maxLength={100} onChange={(e) => setName(e.target.value)} />
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
      <button type="submit" className="text-sm" disabled={rename.isPending || name.trim() === ""}>
        {rename.isPending ? "Saving…" : "Save"}
      </button>
      <button type="button" className="text-sm" onClick={() => setOpen(false)}>
        Cancel
      </button>
      {error && (
        <p role="alert" className="text-loss w-full text-sm">
          {error}
        </p>
      )}
    </form>
  );
};

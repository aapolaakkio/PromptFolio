import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";

import { ApiError, apiPatch } from "../lib/api";

const RenamedSchema = z.object({ id: z.number(), name: z.string() });

/**
 * Renames an account. Only the name: the broker and base currency are facts the
 * stored transactions were already interpreted under, so changing either after
 * rows exist would silently reinterpret them. The server enforces that too.
 */
export const RenameAccount = ({
  accountId,
  currentName,
}: {
  readonly accountId: number;
  readonly currentName: string;
}) => {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(currentName);
  const [error, setError] = useState<string | null>(null);

  const rename = useMutation({
    mutationFn: () => apiPatch(`/api/accounts/${accountId}`, { name: name.trim() }, RenamedSchema),
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
          setOpen(true);
        }}
      >
        Muuta nimeä
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

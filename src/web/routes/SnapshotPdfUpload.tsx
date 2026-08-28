import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";

import { ApiError, apiGet, apiPost, apiUpload } from "../lib/api";
import { eur, fiDate, qty } from "../lib/format";

const InstrumentSchema = z.object({ id: z.number(), name: z.string() });
const CreatedSnapshotSchema = z.object({ id: z.number() });

const PreviewSchema = z.object({
  asOf: z.string(),
  rows: z.array(
    z.object({
      name: z.string(),
      quantity: z.string(),
      costEur: z.string(),
      marketValueEur: z.string(),
      instrumentId: z.number().nullable(),
    }),
  ),
});

/**
 * Uploads a broker's PDF statement, shows what it says, and stores it only once
 * every row is pointed at an instrument.
 *
 * The mapping step is not ceremony: a statement names its funds the way the
 * broker prints them, not the way they are registered here, so an unmatched row
 * is the normal case on a first upload rather than an error. Nothing is stored
 * until the user has resolved them, and a row left unmatched blocks the save
 * instead of being quietly dropped -- a statement missing a holding reads as
 * "you did not own it", which is the one thing it can never mean.
 */
export const SnapshotPdfUpload = ({
  accountId,
  onCreated,
}: {
  readonly accountId: number;
  readonly onCreated: (snapshotId: number) => void;
}) => {
  const queryClient = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [mapping, setMapping] = useState<Record<string, number | null>>({});
  const [error, setError] = useState<string | null>(null);

  const instruments = useQuery({
    queryKey: ["instruments"],
    queryFn: () => apiGet("/api/instruments", z.array(InstrumentSchema)),
  });

  const preview = useMutation({
    mutationFn: (chosen: File) => {
      const form = new FormData();
      form.set("file", chosen);
      return apiUpload("/api/snapshots/pdf", form, PreviewSchema);
    },
    onSuccess: (result) => {
      setError(null);
      setMapping(Object.fromEntries(result.rows.map((row) => [row.name, row.instrumentId])));
    },
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : "PDF:n luku epäonnistui");
    },
  });

  const rows = preview.data?.rows ?? [];
  const unmapped = rows.filter((row) => (mapping[row.name] ?? null) === null).length;

  const save = useMutation({
    mutationFn: () =>
      apiPost(
        "/api/snapshots",
        {
          accountId,
          asOf: preview.data?.asOf ?? "",
          source: "pdf" as const,
          rows: rows.map((row) => ({
            instrumentId: mapping[row.name] ?? 0,
            quantity: row.quantity,
            marketValue: row.marketValueEur,
          })),
        },
        CreatedSnapshotSchema,
      ),
    onSuccess: (snapshot) => {
      setError(null);
      preview.reset();
      setFile(null);
      void queryClient.invalidateQueries({ queryKey: ["snapshots", accountId] });
      onCreated(snapshot.id);
    },
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : "Otteen tallennus epäonnistui");
    },
  });

  return (
    <section className="card mt-6">
      <h2>Lue ote PDF:stä</h2>
      <p className="text-muted">
        Vuosiraportti luetaan sellaisenaan. Rahastot nimetään otteella eri tavalla kuin täällä,
        joten yhdistä rivit ennen tallennusta — mitään ei tallenneta ennen sitä.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <input
          type="file"
          accept="application/pdf"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
        <button
          type="button"
          disabled={file === null || preview.isPending}
          onClick={() => file && preview.mutate(file)}
        >
          {preview.isPending ? "Luetaan…" : "Lue ote"}
        </button>
      </div>

      {error && (
        <p role="alert" className="text-loss mt-3 text-sm">
          {error}
        </p>
      )}

      {preview.data && (
        <>
          <p className="mt-4">
            Ote {fiDate(preview.data.asOf)} — {rows.length} riviä.
          </p>
          <table className="mt-2">
            <thead>
              <tr>
                <th>Otteella</th>
                <th className="num">Määrä</th>
                <th className="num">Markkina-arvo</th>
                <th>Arvopaperi täällä</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.name}>
                  <td>{row.name}</td>
                  <td className="num">{qty(row.quantity)}</td>
                  <td className="num">{eur(row.marketValueEur)}</td>
                  <td>
                    <select
                      value={mapping[row.name] ?? ""}
                      onChange={(e) =>
                        setMapping((current) => ({
                          ...current,
                          [row.name]: e.target.value === "" ? null : Number(e.target.value),
                        }))
                      }
                    >
                      <option value="">— valitse —</option>
                      {(instruments.data ?? []).map((instrument) => (
                        <option key={instrument.id} value={instrument.id}>
                          {instrument.name}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <button
            type="button"
            className="mt-4"
            disabled={unmapped > 0 || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending
              ? "Tallennetaan…"
              : unmapped > 0
                ? `Yhdistä vielä ${unmapped} riviä`
                : "Tallenna ote"}
          </button>
        </>
      )}
    </section>
  );
};

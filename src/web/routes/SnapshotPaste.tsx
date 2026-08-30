import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiError } from "../lib/api.ts";
import {
  proposeSnapshotFromCsv,
  proposeSnapshotFromPaste,
  saveSnapshot,
} from "../server/snapshots.ts";
import { eur, qty } from "../lib/format.ts";
import { getInstruments } from "../server/instruments.ts";

/**
 * Takes a broker's holdings table as pasted text and proposes the snapshot it
 * describes.
 *
 * Two shapes arrive here and the server tells them apart: a CSV or spreadsheet
 * copy, which is tab-separated with a header row, and a table copied from a web
 * page, which is one value per line. The user should not have to know which
 * kind they are holding.
 *
 * Nothing is stored until every row is pointed at an instrument. A statement
 * names its holdings the way the broker prints them, so an unmatched row is
 * ordinary on a first paste rather than an error -- and a row left unmatched
 * blocks the save instead of being dropped, since a statement missing a holding
 * reads as one the owner does not have.
 */
export const SnapshotPaste = ({
  accountId,
  onCreated,
}: {
  readonly accountId: number;
  readonly onCreated: (snapshotId: number) => void;
}) => {
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [asOf, setAsOf] = useState("");
  const [mapping, setMapping] = useState<Record<string, number | null>>({});
  const [error, setError] = useState<string | null>(null);

  const instruments = useQuery({
    queryKey: ["instruments"],
    queryFn: () => getInstruments(),
  });

  // Two sources, one preview: a broker that exports a holdings file (Nordnet)
  // and one that does not (OP), where the table is copied off the page instead.
  const preview = useMutation({
    mutationFn: () => {
      if (file !== null) {
        const form = new FormData();
        form.set("file", file);
        form.set("asOf", asOf);
        return proposeSnapshotFromCsv({ data: form });
      }
      return proposeSnapshotFromPaste({ data: { asOf, text } });
    },
    onSuccess: (result) => {
      setError(null);
      setMapping(Object.fromEntries(result.rows.map((row) => [row.name, row.instrumentId])));
    },
    onError: (cause) => {
      setError(cause instanceof ApiError ? cause.message : "Taulukon luku epäonnistui");
    },
  });

  const rows = preview.data?.rows ?? [];
  const unmapped = rows.filter((row) => (mapping[row.name] ?? null) === null).length;

  const save = useMutation({
    mutationFn: () =>
      saveSnapshot({
        data: {
          accountId,
          asOf,
          source: "manual" as const,
          rows: rows.map((row) => ({
            instrumentId: mapping[row.name] ?? 0,
            quantity: row.quantity,
            marketValue: row.marketValueEur,
          })),
        },
      }),
    onSuccess: (snapshot) => {
      setError(null);
      preview.reset();
      setText("");
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
      <h2>Liitä omistukset</h2>
      <p className="text-muted">
        Lataa välittäjän omistustiedosto tai liitä taulukko suoraan verkkosivulta. Yhdistä rivit
        omiin arvopapereihisi ennen tallennusta; mitään ei tallenneta ennen sitä.
      </p>

      <label className="mt-3 block">
        Otteen päivä
        <input type="date" value={asOf} required onChange={(e) => setAsOf(e.target.value)} />
      </label>

      <label className="mt-3 block">
        Välittäjän tiedosto (esim. Nordnetin CSV)
        <input
          type="file"
          accept=".csv,text/csv,text/plain"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </label>

      <label className="mt-3 block">
        …tai liitä taulukko (esim. OP:n omistusnäkymä)
        <textarea
          value={text}
          rows={8}
          placeholder="Liitä tähän"
          onChange={(e) => setText(e.target.value)}
        />
      </label>

      <button
        type="button"
        className="mt-3"
        disabled={(file === null && text.trim() === "") || asOf === "" || preview.isPending}
        onClick={() => preview.mutate()}
      >
        {preview.isPending ? "Luetaan…" : file !== null ? "Lue tiedosto" : "Lue taulukko"}
      </button>

      {error && (
        <p role="alert" className="text-loss mt-3 text-sm">
          {error}
        </p>
      )}

      {preview.data && (
        <>
          {preview.data.problems.length > 0 && (
            <p className="text-loss mt-3 text-sm">
              {preview.data.problems.length} riviä ei voitu lukea; loput alla.
            </p>
          )}

          <table className="mt-3">
            <thead>
              <tr>
                <th>Otteella</th>
                <th className="num">Määrä</th>
                <th className="num">Arvo</th>
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
            disabled={unmapped > 0 || rows.length === 0 || save.isPending}
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

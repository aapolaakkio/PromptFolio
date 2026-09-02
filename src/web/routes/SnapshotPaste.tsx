import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  proposeSnapshotFromCsv,
  proposeSnapshotFromPaste,
  proposeSnapshotFromPdf,
  saveSnapshot,
} from "../server/snapshots.ts";
import { getInstruments } from "../server/instruments.ts";
import { holdingsTotalCheck } from "./draft-edit.ts";
import { type Column, DraftTable } from "./DraftTable.tsx";

/** A proposed holding as the table edits it; the instrument id travels as text. */
type HoldingRow = {
  readonly line: number;
  readonly name: string;
  readonly quantity: string;
  readonly marketValueEur: string;
  readonly instrumentId: string;
};

const isPdf = (file: File): boolean =>
  file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");

/**
 * Takes a broker's holdings -- a file, a pasted table, or a statement PDF --
 * and proposes the snapshot it describes.
 *
 * Three shapes arrive here and the server tells them apart: a CSV or
 * spreadsheet copy, which is tab-separated with a header row; a table copied
 * from a web page, which is one value per line; and a PDF, which the model
 * reads. The user should not have to know which kind they are holding.
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
  const [rows, setRows] = useState<HoldingRow[]>([]);
  /** What a PDF statement printed as its own total, when it printed one. */
  const [statedTotalEur, setStatedTotalEur] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const instruments = useQuery({
    queryKey: ["instruments"],
    queryFn: () => getInstruments(),
  });

  // Three sources, one preview: a broker that exports a holdings file (Nordnet),
  // one that does not (OP), where the table is copied off the page, and a
  // downloaded statement PDF, which the model reads. A PDF carries its own date
  // and its own printed total, so neither has to be typed in.
  const preview = useMutation({
    mutationFn: async () => {
      if (file !== null && isPdf(file)) {
        const form = new FormData();
        form.set("file", file);
        const read = await proposeSnapshotFromPdf({ data: form });
        return { ...read, statedTotalEur: read.statedTotalEur };
      }
      if (file !== null) {
        const form = new FormData();
        form.set("file", file);
        form.set("asOf", asOf);
        return { ...(await proposeSnapshotFromCsv({ data: form })), statedTotalEur: null };
      }
      return {
        ...(await proposeSnapshotFromPaste({ data: { asOf, text } })),
        statedTotalEur: null,
      };
    },
    onSuccess: (result) => {
      setError(null);
      setAsOf(result.asOf);
      setStatedTotalEur(result.statedTotalEur);
      setRows(
        result.rows.map((row, index) => ({
          line: index + 1,
          name: row.name,
          quantity: row.quantity,
          marketValueEur: row.marketValueEur,
          instrumentId: row.instrumentId === null ? "" : String(row.instrumentId),
        })),
      );
    },
    onError: (cause) => {
      setError(cause instanceof Error ? cause.message : "Taulukon luku epäonnistui");
    },
  });

  const unmapped = rows.filter((row) => row.instrumentId === "").length;
  const totalCheck = holdingsTotalCheck(rows, statedTotalEur);

  const columns: readonly Column<HoldingRow>[] = [
    { key: "name", label: "Otteella", kind: "text" },
    { key: "quantity", label: "Määrä", kind: "decimal", numeric: true },
    { key: "marketValueEur", label: "Arvo", kind: "decimal", numeric: true },
    {
      key: "instrumentId",
      label: "Arvopaperi täällä",
      kind: "select",
      options: [
        { value: "", label: "— valitse —" },
        ...(instruments.data ?? []).map((instrument) => ({
          value: String(instrument.id),
          label: instrument.name,
        })),
      ],
    },
  ];

  const save = useMutation({
    mutationFn: () =>
      saveSnapshot({
        data: {
          accountId,
          asOf,
          source: file !== null && isPdf(file) ? ("pdf" as const) : ("manual" as const),
          statedTotalEur,
          rows: rows.map((row) => ({
            instrumentId: Number(row.instrumentId),
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
      setRows([]);
      setStatedTotalEur(null);
      void queryClient.invalidateQueries({ queryKey: ["snapshots", accountId] });
      onCreated(snapshot.id);
    },
    onError: (cause) => {
      setError(cause instanceof Error ? cause.message : "Otteen tallennus epäonnistui");
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
        Välittäjän tiedosto (CSV) tai omistusote (PDF)
        <input
          type="file"
          accept=".csv,.pdf,text/csv,text/plain,application/pdf"
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
        disabled={
          (file === null && text.trim() === "") ||
          // A PDF carries its own date; everything else needs one typed in.
          (asOf === "" && !(file !== null && isPdf(file))) ||
          preview.isPending
        }
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

          {totalCheck !== null && (
            <p className={totalCheck.ok ? "text-gain mt-3 text-sm" : "text-loss mt-3 text-sm"}>
              {totalCheck.ok
                ? `Rivit täsmäävät otteen kokonaisarvoon ${statedTotalEur} €.`
                : `Rivit eivät täsmää otteen kokonaisarvoon: ero ${totalCheck.differenceEur} €.`}
            </p>
          )}

          <div className="mt-3">
            <DraftTable
              rows={rows}
              columns={columns}
              onChange={setRows}
              blank={(): HoldingRow => ({
                line: rows.length + 1,
                name: "",
                quantity: "",
                marketValueEur: "",
                instrumentId: "",
              })}
            />
          </div>

          <button
            type="button"
            className="mt-4"
            disabled={
              unmapped > 0 || rows.length === 0 || totalCheck?.ok === false || save.isPending
            }
            onClick={() => save.mutate()}
          >
            {save.isPending
              ? "Tallennetaan…"
              : unmapped > 0
                ? `Yhdistä vielä ${unmapped} riviä`
                : totalCheck?.ok === false
                  ? "Korjaa rivit ennen tallennusta"
                  : "Tallenna ote"}
          </button>
        </>
      )}
    </section>
  );
};

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  proposeSnapshotFromCsv,
  proposeSnapshotFromPaste,
  proposeSnapshotFromPdf,
  saveSnapshot,
} from "../server/snapshots.ts";
import { errorMessage } from "../lib/errors.ts";
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

/** Proposes a snapshot from a broker file, pasted table or PDF (the server tells them apart). Nothing is stored until every row matches an instrument: a dropped row would read as a holding the owner lacks. */
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

  const preview = useMutation({
    mutationFn: async () => {
      if (file !== null && isPdf(file)) {
        const form = new FormData();
        form.set("file", file);
        return await proposeSnapshotFromPdf({ data: form });
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
      setError(errorMessage(cause, "Could not read the table"));
    },
  });

  const unmapped = rows.filter((row) => row.instrumentId === "").length;
  const totalCheck = holdingsTotalCheck(rows, statedTotalEur);

  const columns: readonly Column<HoldingRow>[] = [
    { key: "name", label: "On statement", kind: "text" },
    { key: "quantity", label: "Quantity", kind: "decimal", numeric: true },
    { key: "marketValueEur", label: "Value", kind: "decimal", numeric: true },
    {
      key: "instrumentId",
      label: "Instrument here",
      kind: "select",
      options: [
        { value: "", label: "— choose —" },
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
      setError(errorMessage(cause, "Could not save the statement"));
    },
  });

  return (
    <section className="card mt-6">
      <h2>Paste holdings</h2>
      <p className="text-muted">
        Upload the broker's holdings file or paste a table straight from its website. Match the rows
        to your instruments before saving; nothing is saved before that.
      </p>

      <label className="mt-3 block">
        Statement date
        <input type="date" value={asOf} required onChange={(e) => setAsOf(e.target.value)} />
      </label>

      <label className="mt-3 block">
        Broker file (CSV) or holdings statement (PDF)
        <input
          type="file"
          accept=".csv,.pdf,text/csv,text/plain,application/pdf"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </label>

      <label className="mt-3 block">
        …or paste a table (e.g. OP's holdings view)
        <textarea
          value={text}
          rows={8}
          placeholder="Paste here"
          onChange={(e) => setText(e.target.value)}
        />
      </label>

      <button
        type="button"
        className="mt-3"
        disabled={
          (file === null && text.trim() === "") ||
          // A PDF carries its own date.
          (asOf === "" && !(file !== null && isPdf(file))) ||
          preview.isPending
        }
        onClick={() => preview.mutate()}
      >
        {preview.isPending ? "Reading…" : file !== null ? "Read file" : "Read table"}
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
              {preview.data.problems.length} rows could not be read; the rest are below.
            </p>
          )}

          {totalCheck !== null && (
            <p className={totalCheck.ok ? "text-gain mt-3 text-sm" : "text-loss mt-3 text-sm"}>
              {totalCheck.ok
                ? `The rows match the statement total of €${statedTotalEur}.`
                : `The rows do not match the statement total: difference €${totalCheck.differenceEur}.`}
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
              ? "Saving…"
              : unmapped > 0
                ? `Match ${unmapped} more rows`
                : totalCheck?.ok === false
                  ? "Fix the rows before saving"
                  : "Save statement"}
          </button>
        </>
      )}
    </section>
  );
};

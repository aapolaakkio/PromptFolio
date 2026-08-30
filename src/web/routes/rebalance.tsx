import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { Dimension } from "../../core/allocation.ts";
import {
  getDepositPlan,
  getDrift,
  getFees,
  getRebalancePlan,
  getTargets,
  saveTargetAllocation,
} from "../server/rebalance.ts";
import { eur } from "../lib/format.ts";
import {
  DepositSchema,
  DriftSchema,
  FeesSchema,
  PlanSchema,
  SaveResultSchema,
  TargetsSchema,
  targetTotal,
  type DriftRowView,
  type TargetView,
} from "./rebalance-view.ts";

const DIMENSIONS = [
  { value: "kind", label: "Lajeittain" },
  { value: "currency", label: "Valuutoittain" },
  { value: "account", label: "Tileittäin" },
  { value: "instrument", label: "Kohteittain" },
] as const;

const today = (): string => new Date().toISOString().slice(0, 10);

const Badge = ({ children, title }: { children: string; title?: string }) => (
  <span
    className="ml-2 rounded-full border border-line px-2 py-0.5 text-xs text-muted"
    title={title}
  >
    {children}
  </span>
);

const pct = (value: string | null): string =>
  value === null ? "—" : `${value.replace(".", ",")} %`;

/**
 * The gap between the portfolio's shape and the shape its owner wants, and what
 * it would take to close it.
 *
 * Drift is arithmetic and always shown. A suggestion is advice, and always
 * states what it costs before it can be acted on -- which is why the sell view
 * is a deliberate disclosure rather than the default, and why every sale in it
 * carries the gain it would realise.
 */
const DriftTable = ({ rows }: { rows: readonly DriftRowView[] }) => {
  const targeted = rows.filter((row) => !row.untargeted);
  const untargeted = rows.filter((row) => row.untargeted);

  return (
    <>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-line text-left text-muted">
            <th className="py-2">Erä</th>
            <th className="text-right">Tavoite</th>
            <th className="text-right">Nyt</th>
            <th className="text-right">Ero</th>
            <th className="text-right">Siirrettävä</th>
          </tr>
        </thead>
        <tbody>
          {targeted.map((row) => (
            <tr key={row.key} className="border-b border-line">
              <td className="py-2">{row.label}</td>
              <td className="text-right">{pct(row.targetPercent)}</td>
              <td className="text-right">{pct(row.actualPercent)}</td>
              <td className="text-right">
                {pct(row.driftPercent)}
                {row.withinBand && (
                  <Badge title="Ero on alle viisi prosenttiyksikköä.">tavoitteessa</Badge>
                )}
              </td>
              <td className="text-right">{row.driftEur === null ? "—" : eur(row.driftEur)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {untargeted.length > 0 && (
        <p className="mt-2 text-sm text-muted">
          {/* Untargeted is not targeted at zero: only the second implies selling. */}
          Ilman tavoitetta: {untargeted.map((row) => row.label).join(", ")}. Näille ei lasketa eroa
          eikä ehdoteta kauppoja.
        </p>
      )}
    </>
  );
};

const TargetEditor = ({
  dimension,
  rows,
  onSaved,
}: {
  dimension: Dimension;
  rows: readonly DriftRowView[];
  onSaved: () => void;
}) => {
  const stored = useQuery({
    queryKey: ["targets", dimension],
    queryFn: () => getTargets({ data: { by: dimension } }),
  });
  const [draft, setDraft] = useState<TargetView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Start from what is stored, falling back to every slice the portfolio holds
  // so a first-time editor has rows to fill rather than an empty form.
  const targets =
    draft ??
    (stored.data !== undefined && stored.data.length > 0
      ? [...stored.data]
      : rows.map((row) => ({ key: row.key, weightPercent: "" })));

  const total = targetTotal(targets);
  const labelOf = (key: string) => rows.find((row) => row.key === key)?.label ?? key;

  const save = useMutation({
    mutationFn: () => saveTargetAllocation({ data: { dimension, targets } }),
    onSuccess: () => {
      setError(null);
      setDraft(null);
      onSaved();
    },
    // The server's own message says what is wrong -- what the set sums to, or
    // which field it could not read. A blanket "tallennus epäonnistui" throws
    // that away and leaves the owner guessing at their own arithmetic.
    onError: (cause) => setError(cause instanceof Error ? cause.message : "Tallennus epäonnistui"),
  });

  return (
    <section className="mt-6">
      <h2 className="mb-2 text-lg font-semibold">Tavoitejakauma</h2>
      <table className="w-full max-w-md border-collapse text-sm">
        <tbody>
          {targets.map((target, index) => (
            <tr key={target.key} className="border-b border-line">
              <td className="py-1">{labelOf(target.key)}</td>
              <td className="py-1 text-right">
                <input
                  value={target.weightPercent}
                  inputMode="decimal"
                  aria-label={`${labelOf(target.key)} tavoite prosentteina`}
                  className="w-24 border border-line bg-surface px-2 py-1 text-right"
                  onChange={(event) =>
                    setDraft(
                      targets.map((row, at) =>
                        at === index ? { ...row, weightPercent: event.target.value } : row,
                      ),
                    )
                  }
                />{" "}
                %
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-sm">
        {/* Shown while typing: a set that does not sum to 100 % is refused, so
            the reader should not have to submit to find that out. */}
        Yhteensä {total.replace(".", ",")} %{" "}
        {total !== "100.00" && <span className="text-muted">— tavoitteiden on oltava 100 %</span>}
      </p>
      <button
        type="button"
        className="mt-2 border border-line px-3 py-1"
        disabled={save.isPending || total !== "100.00"}
        onClick={() => save.mutate()}
      >
        Tallenna tavoitteet
      </button>
      {error !== null && <p className="mt-2 text-sm">{error}</p>}
    </section>
  );
};

export const RebalancePage = () => {
  const queryClient = useQueryClient();
  // The union rather than a string: the server function takes exactly these
  // four, where the old URL took any text and failed later.
  const [dimension, setDimension] = useState<Dimension>("kind");
  const [deposit, setDeposit] = useState("");
  const [showSells, setShowSells] = useState(false);

  const drift = useQuery({
    queryKey: ["drift", dimension],
    queryFn: () => getDrift({ data: { by: dimension, on: today() } }),
  });
  const depositPlan = useQuery({
    queryKey: ["deposit-plan", dimension, deposit],
    queryFn: () => getDepositPlan({ data: { by: dimension, on: today(), amount: deposit } }),
    enabled: /^\d+([.,]\d{1,2})?$/.test(deposit),
  });
  const plan = useQuery({
    queryKey: ["rebalance", dimension],
    queryFn: () => getRebalancePlan({ data: { by: dimension, on: today() } }),
    enabled: showSells,
  });
  const fees = useQuery({ queryKey: ["fees"], queryFn: () => getFees() });

  return (
    <>
      <h1>Tasapaino</h1>
      <p className="text-muted">
        Ero tavoitteeseen on laskettu tapahtumistasi. Ehdotukset ovat laskelmia, eivät
        sijoitusneuvoja — ja myynnin kohdalla kerrotaan aina mitä voittoa se realisoisi.
      </p>

      <label className="mt-4 block">
        Jaottelu{" "}
        <select
          value={dimension}
          onChange={(event) => {
            // SAFETY: the options are rendered from DIMENSIONS, whose values
            // are exactly the Dimension union.
            setDimension(event.target.value as Dimension);
          }}
          className="border border-line bg-surface px-2 py-1"
        >
          {DIMENSIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      {drift.isPending && <p>Ladataan…</p>}
      {drift.data !== undefined && (
        <>
          {drift.data.incomplete && (
            <p className="mt-4 text-sm text-muted">
              {/* A weight is a share of a total, so one unpriceable holding makes
                  every slice's euro figure wrong by an unknown amount. */}
              Jollekin omistukselle ei ole hintaa, joten euromääräisiä eroja ei voi laskea.
              Prosentit koskevat vain niitä eriä, jotka voitiin arvottaa.
            </p>
          )}

          <section className="mt-6">
            <h2 className="mb-2 text-lg font-semibold">Ero tavoitteeseen</h2>
            <DriftTable rows={drift.data.rows} />
            <p className="mt-2 text-sm text-muted">Salkun arvo {eur(drift.data.totalEur)}.</p>
          </section>

          <TargetEditor
            dimension={dimension}
            rows={drift.data.rows}
            onSaved={() => {
              void queryClient.invalidateQueries({ queryKey: ["drift"] });
              void queryClient.invalidateQueries({ queryKey: ["rebalance"] });
              void queryClient.invalidateQueries({ queryKey: ["deposit-plan"] });
            }}
          />

          <section className="mt-8">
            <h2 className="mb-2 text-lg font-semibold">Uusi sijoitus</h2>
            <p className="text-sm text-muted">
              Mihin seuraava sijoitus kannattaa laittaa. Ei myyntiä, ei realisoitunutta voittoa.
            </p>
            <label className="mt-2 block">
              Summa{" "}
              <input
                value={deposit}
                inputMode="decimal"
                className="w-32 border border-line bg-surface px-2 py-1 text-right"
                onChange={(event) => setDeposit(event.target.value)}
              />{" "}
              €
            </label>
            {depositPlan.data !== undefined &&
              (depositPlan.data.length === 0 ? (
                <p className="mt-2 text-muted">Ei kohdetta — tavoitteet ovat jo täynnä.</p>
              ) : (
                <ul className="mt-2 text-sm">
                  {depositPlan.data.map((allocation) => (
                    <li key={allocation.key}>
                      {allocation.label}: {eur(allocation.amountEur)}
                    </li>
                  ))}
                </ul>
              ))}
          </section>

          <section className="mt-8">
            <h2 className="mb-2 text-lg font-semibold">Täysi tasapainotus</h2>
            {!showSells ? (
              <button
                type="button"
                className="border border-line px-3 py-1"
                onClick={() => setShowSells(true)}
              >
                Näytä myös myynnit
              </button>
            ) : plan.data === undefined ? (
              <p>Ladataan…</p>
            ) : plan.data.trades.length === 0 ? (
              <p className="text-muted">Ei kauppoja — salkku on tavoitteessa.</p>
            ) : (
              <>
                <p className="mb-2 text-sm">
                  Myynnit realisoisivat voittoa yhteensä {eur(plan.data.totalRealisedGainEur)}
                  {plan.data.gainIncomplete && " (osalle ei tiedetä hankintamenoa)"}. Tämä on
                  voitto, ei vero.
                </p>
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-line text-left text-muted">
                      <th className="py-2">Erä</th>
                      <th>Toimi</th>
                      <th className="text-right">Summa</th>
                      <th className="text-right">Realisoituva voitto</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.data.trades.map((trade) => (
                      <tr key={`${trade.key}-${trade.side}`} className="border-b border-line">
                        <td className="py-2">{trade.label}</td>
                        <td>{trade.side === "buy" ? "Osta" : "Myy"}</td>
                        <td className="text-right">{eur(trade.amountEur)}</td>
                        <td className="text-right">
                          {trade.side === "buy"
                            ? "—"
                            : trade.gainUnknown
                              ? "tuntematon"
                              : eur(trade.realisedGainEur ?? "0")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {plan.data.tooSmall.length > 0 && (
                  <p className="mt-2 text-sm text-muted">
                    {/* Listed rather than hidden: the owner may have a reason. */}
                    Alle 50 € jääneet kaupat jätettiin pois:{" "}
                    {plan.data.tooSmall
                      .map((trade) => `${trade.label} ${eur(trade.amountEur)}`)
                      .join(", ")}
                    .
                  </p>
                )}
              </>
            )}
          </section>
        </>
      )}

      <section className="mt-8">
        <h2 className="mb-2 text-lg font-semibold">Kulut</h2>
        {fees.data !== undefined && fees.data.length === 0 && (
          <p className="text-muted">Ei kuluja.</p>
        )}
        {fees.data !== undefined && fees.data.length > 0 && (
          <>
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-line text-left text-muted">
                  <th className="py-2">Vuosi</th>
                  <th className="text-right">Kaupankäyntikulut</th>
                  <th className="text-right">Palvelumaksut</th>
                  <th className="text-right">Yhteensä</th>
                  <th className="text-right">Pidätetty vero</th>
                </tr>
              </thead>
              <tbody>
                {fees.data.map((year) => (
                  <tr key={year.year} className="border-b border-line">
                    <td className="py-2">{year.year}</td>
                    <td className="text-right">{eur(year.tradeFeesEur)}</td>
                    <td className="text-right">{eur(year.chargedFeesEur)}</td>
                    <td className="text-right">{eur(year.totalEur)}</td>
                    <td className="text-right">{eur(year.withheldTaxEur)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-sm text-muted">
              Osakesäästötililtä pidätetty pääomatulovero näkyy omana sarakkeenaan eikä sisälly
              kuluihin: se on veroa voitosta, ei sijoittamisen kustannus.
            </p>
          </>
        )}
      </section>
    </>
  );
};

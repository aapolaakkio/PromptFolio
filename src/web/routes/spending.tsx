import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { ApiError, apiDelete, apiGet, apiPost } from "../lib/api";
import { eur } from "../lib/format";
import { CashFlowChart } from "../charts/CashFlowChart";
import { MonthlyFlowChart } from "../charts/MonthlyFlowChart";
import { CashFlowSchema, MonthlySchema, RulesSchema, SpendingSchema } from "./cash-view";

const today = (): string => new Date().toISOString().slice(0, 10);
const yearAgo = (): string => {
  const date = new Date();
  date.setUTCFullYear(date.getUTCFullYear() - 1);
  return date.toISOString().slice(0, 10);
};

/**
 * Where the money went, and the rules that decide it.
 *
 * The figures are summed on the server, not here and not by the assistant: a
 * spending total someone acts on has to be arithmetic, not an estimate. What
 * this screen adds is the part a person has to judge -- which shop belongs in
 * which bucket -- and the share of spending no rule matched, so a total is
 * never quietly missing a third of the money.
 */
export const SpendingPage = () => {
  const queryClient = useQueryClient();
  const [from, setFrom] = useState(yearAgo);
  const [to, setTo] = useState(today);
  const [groupBy, setGroupBy] = useState<"category" | "counterparty">("category");
  const [showRules, setShowRules] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const spending = useQuery({
    queryKey: ["spending", from, to, groupBy],
    queryFn: () => apiGet(`/api/spending?from=${from}&to=${to}&by=${groupBy}`, SpendingSchema),
  });

  const cashflow = useQuery({
    queryKey: ["cashflow", from, to],
    queryFn: () => apiGet(`/api/cashflow?from=${from}&to=${to}`, CashFlowSchema),
  });

  const monthly = useQuery({
    queryKey: ["monthly", from, to],
    queryFn: () => apiGet(`/api/spending/monthly?from=${from}&to=${to}`, MonthlySchema),
  });

  const rules = useQuery({
    queryKey: ["spending-rules"],
    enabled: showRules,
    queryFn: () => apiGet("/api/spending/rules", RulesSchema),
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["spending"] });
    void queryClient.invalidateQueries({ queryKey: ["spending-rules"] });
  };

  const removeRule = useMutation({
    mutationFn: (pattern: string) =>
      apiDelete(`/api/spending/rules?pattern=${encodeURIComponent(pattern)}`),
    onSuccess: refresh,
    onError: (cause) =>
      setError(cause instanceof ApiError ? cause.message : "Säännön poisto epäonnistui"),
  });

  return (
    <section className="grid gap-6">
      <div>
        <h1>Kulutus</h1>
        <p className="max-w-prose text-muted">
          Pankkitileiltä lähtenyt raha jaksolla. Sijoitusostot eivät ole kuluja eivätkä näy tässä.
        </p>
      </div>

      {error !== null && (
        <p role="alert" className="text-loss">
          {error}
        </p>
      )}

      <div className="card grid gap-3">
        <div className="flex flex-wrap items-end gap-2">
          <label>
            Alkaen
            <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </label>
          <label>
            Asti
            <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </label>
          <label>
            Ryhmittely
            <select
              value={groupBy}
              onChange={(event) =>
                setGroupBy(event.target.value === "counterparty" ? "counterparty" : "category")
              }
            >
              <option value="category">Luokittain</option>
              <option value="counterparty">Saajittain</option>
            </select>
          </label>
        </div>

        <h2 className="text-sm text-muted">Rahavirrat</h2>
        {cashflow.data?.empty === false ? (
          <CashFlowChart nodes={cashflow.data.nodes} links={cashflow.data.links} />
        ) : (
          <p className="text-muted">Ei rahavirtoja tällä jaksolla.</p>
        )}
        <p className="max-w-prose text-muted text-sm">
          Omien tilien väliset siirrot on jätetty pois molemmilta puolilta: raha, jonka siirrät
          käyttötililtä säästöön, ei ole tuloa eikä menoa. Sijoituksiin-haara on arvopaperitilien
          talletukset. Viimeinen haara on jäännös, eli se osa jota muut eivät selitä.
        </p>

        <h2 className="mt-2 text-sm text-muted">Kuukausittain</h2>
        <MonthlyFlowChart months={monthly.data?.months ?? []} />

        <h2 className="mt-2 text-sm text-muted">
          {groupBy === "category" ? "Luokittain" : "Saajittain"}
        </h2>
        <div className="max-h-128 overflow-auto rounded border border-line">
          <table>
            <thead className="sticky top-0 bg-surface">
              <tr>
                <th>{groupBy === "category" ? "Luokka" : "Saaja"}</th>
                <th className="text-right">Tapahtumia</th>
                <th className="text-right">Yhteensä</th>
              </tr>
            </thead>
            <tbody>
              {(spending.data?.groups ?? []).map((group) => (
                <tr key={group.key}>
                  <td>{group.label}</td>
                  <td className="text-right">{group.count}</td>
                  <td className="text-right">{eur(group.totalEur)}</td>
                </tr>
              ))}
              {(spending.data?.groups ?? []).length === 0 && (
                <tr>
                  <td colSpan={3} className="text-muted">
                    Ei kuluja tällä jaksolla. Tuo tiliote Käteinen-välilehdeltä.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {spending.data && (
          <p className="text-muted text-sm">
            Yhteensä {eur(spending.data.totalEur)}.{" "}
            {spending.data.uncategorisedShare > 0.05 &&
              `Luokittelematta ${Math.round(spending.data.uncategorisedShare * 100)} % — nämä näkyvät luokassa Muu.`}
          </p>
        )}
      </div>

      <div className="card grid gap-3">
        <button
          type="button"
          className="justify-self-start"
          onClick={() => setShowRules((v) => !v)}
        >
          {showRules ? "Piilota luokittelusäännöt" : "Näytä luokittelusäännöt"}
        </button>

        {showRules && (
          <>
            <p className="max-w-prose text-muted text-sm">
              Sääntö osuu maksun tekstiin osajonona, ja pisin osuma voittaa. Lähde kertoo kuka
              päätti: valmis sääntö, avustajan arvaus tuonnin yhteydessä, vai sinä.
            </p>
            <AddRuleForm
              categories={rules.data?.categories ?? []}
              onSaved={refresh}
              onError={setError}
            />
            <div className="max-h-96 overflow-auto rounded border border-line">
              <table>
                <thead className="sticky top-0 bg-surface">
                  <tr>
                    <th>Hakusana</th>
                    <th>Luokka</th>
                    <th>Lähde</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {(rules.data?.rules ?? []).map((rule) => (
                    <tr key={rule.pattern}>
                      <td>{rule.pattern}</td>
                      <td>{rule.category}</td>
                      <td className="text-muted">{rule.source}</td>
                      <td>
                        <button
                          type="button"
                          className="text-sm"
                          aria-label={`Poista sääntö ${rule.pattern}`}
                          onClick={() => removeRule.mutate(rule.pattern)}
                        >
                          Poista
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </section>
  );
};

/** One pattern and the bucket it belongs in, entered by hand. */
const AddRuleForm = ({
  categories,
  onSaved,
  onError,
}: {
  readonly categories: readonly { id: string; label: string }[];
  readonly onSaved: () => void;
  readonly onError: (message: string) => void;
}) => {
  const [pattern, setPattern] = useState("");
  const [category, setCategory] = useState("");

  const save = useMutation({
    mutationFn: () =>
      apiPost("/api/spending/rules", { rules: [{ pattern: pattern.trim(), category }] }),
    onSuccess: () => {
      setPattern("");
      onSaved();
    },
    onError: (cause) =>
      onError(cause instanceof ApiError ? cause.message : "Säännön tallennus epäonnistui"),
  });

  const chosen = category === "" ? (categories[0]?.id ?? "") : category;

  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <label>
        Hakusana
        <input
          value={pattern}
          maxLength={60}
          placeholder="esim. K-MARKET"
          onChange={(event) => setPattern(event.target.value)}
        />
      </label>
      <label>
        Luokka
        <select value={chosen} onChange={(event) => setCategory(event.target.value)}>
          {categories.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" disabled={pattern.trim().length < 3 || save.isPending}>
        {save.isPending ? "Tallennetaan…" : "Lisää sääntö"}
      </button>
    </form>
  );
};

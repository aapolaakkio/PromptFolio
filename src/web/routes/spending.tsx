import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { ApiError, apiDelete, apiGet, apiPost } from "../lib/api.ts";
import { eur, fiDate } from "../lib/format.ts";
import { CashFlowChart } from "../charts/CashFlowChart.tsx";
import { CategoryTrendChart } from "../charts/CategoryTrendChart.tsx";
import { MonthlyFlowChart } from "../charts/MonthlyFlowChart.tsx";
import {
  CashFlowSchema,
  ClassifiedSchema,
  EXCLUDED_LABELS,
  MonthlySchema,
  RulesSchema,
  SpendingSchema,
  UncategorisedSchema,
} from "./cash-view.ts";

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
  const [showLedger, setShowLedger] = useState(false);
  /** Which class to show; "" is everything. */
  const [onlyCategory, setOnlyCategory] = useState("");
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

  const unknown = useQuery({
    queryKey: ["uncategorised", from, to],
    queryFn: () => apiGet(`/api/spending/uncategorised?from=${from}&to=${to}`, UncategorisedSchema),
  });

  const rules = useQuery({
    queryKey: ["spending-rules"],
    enabled: showRules,
    queryFn: () => apiGet("/api/spending/rules", RulesSchema),
  });

  const ledger = useQuery({
    queryKey: ["spending-transactions", from, to],
    enabled: showLedger,
    queryFn: () => apiGet(`/api/spending/transactions?from=${from}&to=${to}`, ClassifiedSchema),
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["spending"] });
    void queryClient.invalidateQueries({ queryKey: ["spending-rules"] });
    void queryClient.invalidateQueries({ queryKey: ["uncategorised"] });
    void queryClient.invalidateQueries({ queryKey: ["cashflow"] });
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

        {/* A trend needs something to trend across: over a single month the
            area has nothing to connect and can only draw empty space. The
            Sankey and the category table already say where that month's money
            went. */}
        {(monthly.data?.byCategory.months.length ?? 0) > 1 && (
          <>
            <h2 className="mt-2 text-sm text-muted">Luokittain kuukausittain</h2>
            <CategoryTrendChart
              months={monthly.data?.byCategory.months ?? []}
              categories={monthly.data?.byCategory.categories ?? []}
            />
          </>
        )}

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
        <h2>Luokittelemattomat</h2>
        <p className="max-w-prose text-muted text-sm">
          Maksut joihin mikään sääntö ei osu. Ne näkyvät luokassa Muu. Valitse luokka, niin sääntö
          tallentuu ja koskee jatkossa myös uusia tapahtumia.
        </p>
        {unknown.data && unknown.data.merchants.length === 0 ? (
          <p className="text-muted">Kaikki jakson maksut on luokiteltu.</p>
        ) : (
          <>
            <p className="text-muted text-sm">
              Yhteensä {eur(unknown.data?.totalEur ?? "0.00")} (
              {unknown.data?.merchants.length ?? 0} saajaa)
            </p>
            <div className="max-h-96 overflow-auto rounded border border-line">
              <table>
                <thead className="sticky top-0 bg-surface">
                  <tr>
                    <th>Saaja</th>
                    <th className="text-right">Lkm</th>
                    <th className="text-right">Yhteensä</th>
                    <th>Luokittele</th>
                  </tr>
                </thead>
                <tbody>
                  {(unknown.data?.merchants ?? []).map((merchant) => (
                    <tr key={merchant.name}>
                      <td>{merchant.name}</td>
                      <td className="text-right">{merchant.count}</td>
                      <td className="text-right">{eur(merchant.totalEur)}</td>
                      <td>
                        {merchant.payeeKnown ? (
                          <ClassifyOne
                            merchant={merchant.name}
                            categories={unknown.data?.categories ?? []}
                            onSaved={refresh}
                            onError={setError}
                          />
                        ) : (
                          // A rule on a bare label would file every payment of
                          // that kind, not the one in front of the reader.
                          <span className="text-muted text-sm">
                            ei saajatietoa — tuo tiliote PDF-muodossa
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      <div className="card grid gap-3">
        {/* The categorised totals above are summaries, and a summary nobody can
            open is one they have to take on trust. This is the ledger behind
            them, with the same exclusions shown as reasons on the row rather
            than as rows that quietly are not there. */}
        <button
          type="button"
          className="mt-4 text-sm underline"
          onClick={() => setShowLedger(!showLedger)}
        >
          {showLedger ? "Piilota tapahtumat" : "Näytä kaikki tapahtumat ja luokat"}
        </button>

        {showLedger && (
          <>
            <label className="mt-2 block text-sm">
              Luokka{" "}
              <select
                value={onlyCategory}
                onChange={(event) => setOnlyCategory(event.target.value)}
                className="border border-line bg-surface px-2 py-1"
              >
                <option value="">Kaikki</option>
                {[...new Set((ledger.data?.transactions ?? []).map((row) => row.categoryLabel))]
                  .sort()
                  .map((label) => (
                    <option key={label} value={label}>
                      {label}
                    </option>
                  ))}
              </select>
            </label>
            <div className="mt-2 max-h-128 overflow-auto rounded border border-line">
              <table>
                <thead className="sticky top-0 bg-surface">
                  <tr>
                    <th>Päivä</th>
                    <th>Teksti</th>
                    <th>Luokka</th>
                    <th className="text-right">Summa</th>
                  </tr>
                </thead>
                <tbody>
                  {(ledger.data?.transactions ?? [])
                    .filter((row) => onlyCategory === "" || row.categoryLabel === onlyCategory)
                    .map((row) => (
                      <tr key={row.id}>
                        <td>{fiDate(row.date)}</td>
                        <td>
                          {row.text === "" ? <span className="text-muted">—</span> : row.text}
                        </td>
                        <td>
                          {row.categoryLabel}
                          {row.excludedReason !== null && (
                            <span className="ml-2 text-muted text-xs">
                              ei kulua: {EXCLUDED_LABELS[row.excludedReason]}
                            </span>
                          )}
                        </td>
                        <td className="num text-right">{eur(row.amountEur)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
            {ledger.data?.transactions.length === 0 && (
              <p className="text-muted">Ei tapahtumia tällä jaksolla.</p>
            )}
          </>
        )}

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

/**
 * Files one unmatched merchant under a category, as a rule.
 *
 * The whole name becomes the pattern rather than a guessed stem: it is what the
 * statement actually prints, and a shorter pattern the owner did not choose
 * could quietly catch payments they never looked at. Shortening it is then a
 * deliberate edit in the rules table.
 */
const ClassifyOne = ({
  merchant,
  categories,
  onSaved,
  onError,
}: {
  readonly merchant: string;
  readonly categories: readonly { id: string; label: string }[];
  readonly onSaved: () => void;
  readonly onError: (message: string) => void;
}) => {
  const save = useMutation({
    mutationFn: (category: string) =>
      apiPost("/api/spending/rules", { rules: [{ pattern: merchant, category }] }),
    onSuccess: onSaved,
    onError: (cause) =>
      onError(cause instanceof ApiError ? cause.message : "Säännön tallennus epäonnistui"),
  });

  return (
    <select
      value=""
      disabled={save.isPending}
      aria-label={`Luokittele ${merchant}`}
      onChange={(event) => {
        if (event.target.value !== "") save.mutate(event.target.value);
      }}
    >
      <option value="">Valitse…</option>
      {categories
        .filter((category) => category.id !== "muu")
        .map((category) => (
          <option key={category.id} value={category.id}>
            {category.label}
          </option>
        ))}
    </select>
  );
};

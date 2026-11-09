import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { errorMessage } from "../lib/errors.ts";
import { eur, formatDate } from "../lib/format.ts";
import {
  deleteSpendingRule,
  getSpendingRules,
  saveSpendingRules,
} from "../server/spending-rules.ts";
import {
  getCashFlow,
  getClassifiedTransactions,
  getMonthlySpending,
  getSpending,
  getUncategorised,
} from "../server/portfolio.ts";
import { CashFlowChart } from "../charts/CashFlowChart.tsx";
import { CategoryTrendChart } from "../charts/CategoryTrendChart.tsx";
import { MonthlyFlowChart } from "../charts/MonthlyFlowChart.tsx";
import { EXCLUDED_LABELS } from "./cash-view.ts";

const today = (): string => new Date().toISOString().slice(0, 10);
const yearAgo = (): string => {
  const date = new Date();
  date.setUTCFullYear(date.getUTCFullYear() - 1);
  return date.toISOString().slice(0, 10);
};

/** Where the money went and the rules deciding it; sums come from the server. The screen adds the judgement of which shop belongs in which bucket. */
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
    queryFn: () => getSpending({ data: { from, to, by: groupBy } }),
  });

  const cashflow = useQuery({
    queryKey: ["cashflow", from, to, groupBy],
    queryFn: () => getCashFlow({ data: { from, to, by: groupBy } }),
  });

  const monthly = useQuery({
    queryKey: ["monthly", from, to],
    queryFn: () => getMonthlySpending({ data: { from, to } }),
  });

  const unknown = useQuery({
    queryKey: ["uncategorised", from, to],
    queryFn: () => getUncategorised({ data: { from, to } }),
  });

  const rules = useQuery({
    queryKey: ["spending-rules"],
    enabled: showRules,
    queryFn: () => getSpendingRules(),
  });

  const ledger = useQuery({
    queryKey: ["spending-transactions", from, to],
    enabled: showLedger,
    queryFn: () => getClassifiedTransactions({ data: { from, to } }),
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["spending"] });
    void queryClient.invalidateQueries({ queryKey: ["spending-rules"] });
    void queryClient.invalidateQueries({ queryKey: ["uncategorised"] });
    void queryClient.invalidateQueries({ queryKey: ["cashflow"] });
  };

  const removeRule = useMutation({
    mutationFn: (pattern: string) => deleteSpendingRule({ data: { pattern } }),
    onSuccess: refresh,
    onError: (cause) => setError(errorMessage(cause, "Could not delete the rule")),
  });

  return (
    <section className="grid gap-6">
      <div>
        <h1>Spending</h1>
        <p className="max-w-prose text-muted">
          Money that left the bank accounts in the period. Investment purchases are not spending and
          do not appear here.
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
            From
            <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </label>
          <label>
            To
            <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </label>
          <label>
            Group by
            <select
              value={groupBy}
              onChange={(event) =>
                setGroupBy(event.target.value === "counterparty" ? "counterparty" : "category")
              }
            >
              <option value="category">By category</option>
              <option value="counterparty">By payee</option>
            </select>
          </label>
        </div>

        <h2 className="text-sm text-muted">Cash flows</h2>
        {cashflow.data?.empty === false ? (
          <CashFlowChart nodes={cashflow.data.nodes} links={cashflow.data.links} />
        ) : (
          <p className="text-muted">No cash flows in this period.</p>
        )}
        <p className="max-w-prose text-muted text-sm">
          Transfers between your own accounts are left out on both sides: money you move from a
          current account to savings is neither income nor spending. The Investments branch is
          deposits into brokerage accounts. The last branch is the remainder, the part the others do
          not explain.
        </p>

        <h2 className="mt-2 text-sm text-muted">By month</h2>
        <MonthlyFlowChart months={monthly.data?.months ?? []} />

        {/* A trend needs more than one month to connect. */}
        {(monthly.data?.byCategory.months.length ?? 0) > 1 && (
          <>
            <h2 className="mt-2 text-sm text-muted">By category by month</h2>
            <CategoryTrendChart
              months={monthly.data?.byCategory.months ?? []}
              categories={monthly.data?.byCategory.categories ?? []}
            />
          </>
        )}

        <h2 className="mt-2 text-sm text-muted">
          {groupBy === "category" ? "By category" : "By payee"}
        </h2>
        <div className="max-h-128 overflow-auto rounded border border-line">
          <table>
            <thead className="sticky top-0 bg-surface">
              <tr>
                <th>{groupBy === "category" ? "Category" : "Payee"}</th>
                <th className="text-right">Transactions</th>
                <th className="text-right">Total</th>
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
                    No spending in this period. Import a bank statement on the Imports page.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {spending.data && (
          <p className="text-muted text-sm">
            Total {eur(spending.data.totalEur)}.{" "}
            {spending.data.uncategorisedShare > 0.05 &&
              `${Math.round(spending.data.uncategorisedShare * 100)} % uncategorised — these appear under Other.`}
          </p>
        )}
      </div>

      <div className="card grid gap-3">
        <h2>Uncategorised</h2>
        <p className="max-w-prose text-muted text-sm">
          Payments that no rule matches. They appear under Other. Choose a category and the rule is
          saved and also applies to new transactions from now on.
        </p>
        {unknown.data && unknown.data.merchants.length === 0 ? (
          <p className="text-muted">Every payment in the period is categorised.</p>
        ) : (
          <>
            <p className="text-muted text-sm">
              Total {eur(unknown.data?.totalEur ?? "0.00")} ({unknown.data?.merchants.length ?? 0}{" "}
              payees)
            </p>
            <div className="max-h-96 overflow-auto rounded border border-line">
              <table>
                <thead className="sticky top-0 bg-surface">
                  <tr>
                    <th>Payee</th>
                    <th className="text-right">Count</th>
                    <th className="text-right">Total</th>
                    <th>Categorise</th>
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
                          // A rule on a bare label would file every payment of that kind.
                          <span className="text-muted text-sm">
                            no payee details — import the bank statement as a PDF
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
        {/* The ledger behind the totals, with exclusions shown as reasons on the row. */}
        <button
          type="button"
          className="mt-4 text-sm underline"
          onClick={() => setShowLedger(!showLedger)}
        >
          {showLedger ? "Hide transactions" : "Show all transactions and categories"}
        </button>

        {showLedger && (
          <>
            <label className="mt-2 block text-sm">
              Category{" "}
              <select
                value={onlyCategory}
                onChange={(event) => setOnlyCategory(event.target.value)}
                className="border border-line bg-surface px-2 py-1"
              >
                <option value="">All</option>
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
                    <th>Date</th>
                    <th>Text</th>
                    <th>Category</th>
                    <th className="text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {(ledger.data?.transactions ?? [])
                    .filter((row) => onlyCategory === "" || row.categoryLabel === onlyCategory)
                    .map((row) => (
                      <tr key={row.id}>
                        <td>{formatDate(row.date)}</td>
                        <td>
                          {row.text === "" ? <span className="text-muted">—</span> : row.text}
                        </td>
                        <td>
                          {row.categoryLabel}
                          {row.excludedReason !== null && (
                            <span className="ml-2 text-muted text-xs">
                              not spending: {EXCLUDED_LABELS[row.excludedReason]}
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
              <p className="text-muted">No transactions in this period.</p>
            )}
          </>
        )}

        <button
          type="button"
          className="justify-self-start"
          onClick={() => setShowRules((v) => !v)}
        >
          {showRules ? "Hide categorisation rules" : "Show categorisation rules"}
        </button>

        {showRules && (
          <>
            <p className="max-w-prose text-muted text-sm">
              A rule matches as a substring of the payment text, and the longest match wins. The
              source says who decided: a built-in rule, the assistant's guess during an import, or
              you.
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
                    <th>Pattern</th>
                    <th>Category</th>
                    <th>Source</th>
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
                          aria-label={`Delete rule ${rule.pattern}`}
                          onClick={() => removeRule.mutate(rule.pattern)}
                        >
                          Delete
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
      saveSpendingRules({ data: { rules: [{ pattern: pattern.trim(), category }] } }),
    onSuccess: () => {
      setPattern("");
      onSaved();
    },
    onError: (cause) => onError(errorMessage(cause, "Could not save the rule")),
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
        Pattern
        <input
          value={pattern}
          maxLength={60}
          placeholder="e.g. K-MARKET"
          onChange={(event) => setPattern(event.target.value)}
        />
      </label>
      <label>
        Category
        <select value={chosen} onChange={(event) => setCategory(event.target.value)}>
          {categories.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" disabled={pattern.trim().length < 3 || save.isPending}>
        {save.isPending ? "Saving…" : "Add rule"}
      </button>
    </form>
  );
};

/** Files one unmatched merchant under a category; the whole name is the pattern, since a guessed stem could catch unseen payments. */
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
      saveSpendingRules({ data: { rules: [{ pattern: merchant, category }] } }),
    onSuccess: onSaved,
    onError: (cause) => onError(errorMessage(cause, "Could not save the rule")),
  });

  return (
    <select
      value=""
      disabled={save.isPending}
      aria-label={`Categorise ${merchant}`}
      onChange={(event) => {
        if (event.target.value !== "") save.mutate(event.target.value);
      }}
    >
      <option value="">Choose…</option>
      {categories
        .filter((category) => category.id !== "other")
        .map((category) => (
          <option key={category.id} value={category.id}>
            {category.label}
          </option>
        ))}
    </select>
  );
};

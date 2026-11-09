import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { RecordPriceForm } from "./RecordPriceForm.tsx";
import { eur, formatDate, qty } from "../lib/format.ts";
import { methodLabel, type TaxYearView } from "./tax-view.ts";
import { getTaxYear, getTaxYears } from "../server/tax.ts";

const Badge = ({ children, title }: { children: string; title?: string }) => (
  <span
    className="ml-2 rounded-full border border-line px-2 py-0.5 text-xs text-muted"
    title={title}
  >
    {children}
  </span>
);

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section className="mt-8">
    <h2 className="mb-2 text-lg font-semibold">{title}</h2>
    {children}
  </section>
);

const Empty = ({ children }: { children: string }) => <p className="text-muted">{children}</p>;

/** Realised gains, dividends and equity-savings-account withdrawals for one year, as a check against the pre-filled return, not a filing. No tax-owed figure: the 30/34 % bracket depends on capital income this app cannot see. */
const Disposals = ({ report }: { report: TaxYearView }) => {
  if (report.disposals.length === 0) return <Empty>No disposals this year.</Empty>;

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-line text-left text-muted">
            <th className="py-2">Sold</th>
            <th>Instrument</th>
            <th>Account</th>
            <th className="text-right">Quantity</th>
            <th className="text-right">Sale price</th>
            <th className="text-right">Cost basis</th>
            <th className="text-right">Gain/loss</th>
          </tr>
        </thead>
        <tbody>
          {report.disposals.map((row) => (
            <tr
              key={`${row.isin}-${row.soldOn}-${row.acquiredOn}`}
              className="border-b border-line"
            >
              <td className="py-2">{formatDate(row.soldOn)}</td>
              <td>
                {row.instrument}
                <span className="block text-xs text-muted">
                  acquired {formatDate(row.acquiredOn)}
                </span>
              </td>
              <td>{row.accountName}</td>
              <td className="text-right">{qty(row.quantity)}</td>
              <td className="text-right">{eur(row.grossProceedsEur)}</td>
              <td className="text-right">
                {eur(row.method === "deemed" ? row.deemedCostEur : row.actualCostEur)}
                <span className="block text-xs text-muted">{methodLabel(row)}</span>
              </td>
              <td className="text-right">
                {eur(row.gainEur)}
                {/* The rejected method's figure, so the choice is visible. */}
                <span className="block text-xs text-muted">
                  {row.method === "deemed"
                    ? `with actual cost ${eur(row.actualGainEur)}`
                    : `with deemed cost ${eur(row.deemedGainEur)}`}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

/** The blocked row's way out: its blocking holding has usually been sold, so the price form is offered here. */
const FixPrice = ({
  instrument,
  on,
  label,
}: {
  instrument: { id: number; name: string; currency: string };
  on: string;
  label: string;
}) => {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button type="button" className="text-xs underline" onClick={() => setOpen(true)}>
        {label} {instrument.name} {formatDate(on)}
      </button>
    );
  }
  return (
    <RecordPriceForm
      instrumentId={instrument.id}
      currency={instrument.currency}
      defaultDate={on}
      onRecorded={() => {
        setOpen(false);
        void queryClient.invalidateQueries({ queryKey: ["tax"] });
      }}
    />
  );
};

const Ost = ({ report }: { report: TaxYearView }) => {
  if (report.ost.length === 0) return <Empty>No equity savings accounts.</Empty>;

  return (
    <>
      {report.ost.map((account) => (
        <div key={account.accountName} className="mb-6">
          <h3 className="font-medium">{account.accountName}</h3>
          <p className="text-sm text-muted">
            {/* Not the balance: paid in over the account's life, less the capital part of
                withdrawals -- the figure the €100,000 cap is measured against. */}
            Total deposits {eur(account.depositedEur)} (less the capital part of withdrawals), so
            {eur(account.capRemainingEur)} of room remains
            {account.incomplete && (
              <Badge title="The taxable part of at least one withdrawal could not be calculated, so its capital part has not been deducted from deposits. The real figure is lower.">
                incomplete
              </Badge>
            )}
          </p>
          {account.withdrawals.length === 0 ? (
            <Empty>No withdrawals this year.</Empty>
          ) : (
            <table className="mt-2 w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-line text-left text-muted">
                  <th className="py-2">Withdrawn</th>
                  <th className="text-right">Amount</th>
                  <th className="text-right">Account value</th>
                  <th className="text-right">Profit</th>
                  <th className="text-right">Taxable</th>
                  <th className="text-right">Tax withheld</th>
                </tr>
              </thead>
              <tbody>
                {account.withdrawals.map((row) => (
                  <tr key={`${row.withdrawnOn}-${row.amountEur}`} className="border-b border-line">
                    <td className="py-2">{formatDate(row.withdrawnOn)}</td>
                    <td className="text-right">{eur(row.amountEur)}</td>
                    <td className="text-right">
                      {row.valueEur === null ? "—" : eur(row.valueEur)}
                      {/* A valuation on a carried-forward price is not priced on the day. */}
                      {row.pricedFrom !== null && (
                        <Badge
                          title={`The account value uses the price from ${row.pricedFrom}, because there is no price for the withdrawal date. The figure sharpens once you record a price for that date.`}
                        >
                          {`price ${formatDate(row.pricedFrom)}`}
                        </Badge>
                      )}
                    </td>
                    <td className="text-right">
                      {row.profitEur === null ? "—" : eur(row.profitEur)}
                    </td>
                    <td className="text-right">
                      {row.taxableEur === null ? (
                        <>
                          <Badge title={row.blockedBy ?? undefined}>cannot be calculated</Badge>
                          {row.priceInstrument !== null && (
                            <span className="mt-1 block">
                              <FixPrice
                                instrument={row.priceInstrument}
                                on={row.withdrawnOn}
                                label="Record price:"
                              />
                            </span>
                          )}
                        </>
                      ) : (
                        <>
                          {eur(row.taxableEur)}
                          {/* A computed row can still rest on an old price, so offer the fix here too. */}
                          {row.pricedFrom !== null && row.priceInstrument !== null && (
                            <span className="mt-1 block">
                              <FixPrice
                                instrument={row.priceInstrument}
                                on={row.withdrawnOn}
                                label="Refine with a price:"
                              />
                            </span>
                          )}
                        </>
                      )}
                    </td>
                    {/* The broker's own figure, beside ours. */}
                    <td className="text-right">{eur(row.withheldEur)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ))}
    </>
  );
};

const Dividends = ({ report }: { report: TaxYearView }) => {
  if (report.dividends.length === 0) return <Empty>No dividends this year.</Empty>;
  const anyMissing = report.dividends.some((row) => !row.withholdingRecorded);

  return (
    <>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-line text-left text-muted">
            <th className="py-2">Paid</th>
            <th>Instrument</th>
            <th className="text-right">Gross</th>
            <th className="text-right">Withholding</th>
            <th className="text-right">Taxable 85 %</th>
          </tr>
        </thead>
        <tbody>
          {report.dividends.map((row) => (
            <tr key={`${row.paidOn}-${row.instrument ?? ""}`} className="border-b border-line">
              <td className="py-2">{formatDate(row.paidOn)}</td>
              <td>{row.instrument ?? "Unknown"}</td>
              <td className="text-right">
                {eur(row.grossEur)}
                {!row.withholdingRecorded && (
                  <Badge title="The bank statement has no separate withholding, so this is the amount that reached the account. If the broker withheld tax, the real gross is higher.">
                    net?
                  </Badge>
                )}
              </td>
              <td className="text-right">{eur(row.withheldEur)}</td>
              <td className="text-right">{eur(row.taxableEur)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {anyMissing && (
        <p className="mt-2 text-sm text-muted">
          Neither broker itemises dividend withholding in the import, so gross here equals the
          amount that reached the account. If tax was withheld, the taxable part is larger than
          shown above.
        </p>
      )}
    </>
  );
};

export const TaxPage = () => {
  const years = useQuery({
    queryKey: ["tax-years"],
    queryFn: () => getTaxYears(),
  });
  const [year, setYear] = useState<number | null>(null);
  const selected = year ?? years.data?.[0] ?? null;

  const report = useQuery({
    queryKey: ["tax", selected],
    // `enabled` keeps this from running while `selected` is null; ?? 0 only satisfies the type.
    queryFn: () => getTaxYear({ data: { year: selected ?? 0 } }),
    enabled: selected !== null,
  });

  return (
    <>
      <h1>Tax</h1>
      <p className="text-muted">
        The figures are calculated from your transactions. They are meant for checking the
        pre-filled tax return, not replacing it — and the amount of tax is not calculated, because
        the capital income tax rate also depends on income this app cannot see.
      </p>

      {years.isPending && <p>Loading…</p>}
      {years.data?.length === 0 && <Empty>No taxable events in any year.</Empty>}

      {years.data !== undefined && years.data.length > 0 && (
        <label className="mt-4 block">
          Tax year{" "}
          <select
            value={selected ?? ""}
            onChange={(event) => setYear(Number(event.target.value))}
            className="border border-line bg-surface px-2 py-1"
          >
            {years.data.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
      )}

      {report.data !== undefined && (
        <>
          <Section title="Disposals">
            {report.data.exempt && report.data.disposals.length > 0 && (
              <p className="mb-2 text-sm text-muted">
                Total sales for the year {eur(report.data.totalSalePriceEur)} — at most €1,000, so
                gains are tax-free and losses are not deductible.
              </p>
            )}
            <Disposals report={report.data} />
            {!report.data.exempt && report.data.disposals.length > 0 && (
              <p className="mt-2 text-sm">
                Gains {eur(report.data.gainsEur)}, losses {eur(report.data.lossesEur)}, taxable{" "}
                {eur(report.data.netEur)}.
                {report.data.lossCarriedIn.length > 0 &&
                  ` Used from earlier years: ${eur(report.data.lossesUsedEur)}.`}
              </p>
            )}
            {report.data.lossCarriedOut.length > 0 && (
              <p className="mt-1 text-sm text-muted">
                Carried forward to later years:{" "}
                {report.data.lossCarriedOut
                  .map((loss) => `${loss.fromYear} ${eur(loss.amountEur)}`)
                  .join(", ")}
              </p>
            )}
          </Section>

          <Section title="Dividends">
            <Dividends report={report.data} />
            {report.data.dividends.length > 0 && (
              <p className="mt-2 text-sm">
                Total taxable dividend income {eur(report.data.dividendTaxableEur)}.
              </p>
            )}
          </Section>

          <Section title="Equity savings account">
            <Ost report={report.data} />
          </Section>

          <p className="mt-8 text-xs text-muted">
            Calculated from {report.data.source.transactions} transactions
            {report.data.source.earliest !== null &&
              `, earliest ${formatDate(report.data.source.earliest)}`}
            . If transactions are missing, the figures are incomplete — no check can detect that.
          </p>
        </>
      )}
    </>
  );
};

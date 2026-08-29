import { useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { apiGet } from "../lib/api";
import { eur, fiDate, qty } from "../lib/format";
import { methodLabel, TaxYearSchema, TaxYearsSchema, type TaxYearView } from "./tax-view";

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

/**
 * Realised gains, dividends and equity-savings-account withdrawals for one
 * year, computed from the ledger.
 *
 * This is a check against the pre-filled return, not a filing: Finnish brokers
 * report to Verohallinto already, so what a second derivation is worth is
 * disagreement. No euro figure for tax owed appears anywhere -- the 30/34 %
 * bracket depends on capital income this app cannot see.
 */
const Disposals = ({ report }: { report: TaxYearView }) => {
  if (report.disposals.length === 0) return <Empty>Ei luovutuksia tänä vuonna.</Empty>;

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-line text-left text-muted">
            <th className="py-2">Myyty</th>
            <th>Instrumentti</th>
            <th>Tili</th>
            <th className="text-right">Määrä</th>
            <th className="text-right">Myyntihinta</th>
            <th className="text-right">Hankintameno</th>
            <th className="text-right">Voitto/tappio</th>
          </tr>
        </thead>
        <tbody>
          {report.disposals.map((row) => (
            <tr
              key={`${row.isin}-${row.soldOn}-${row.acquiredOn}`}
              className="border-b border-line"
            >
              <td className="py-2">{fiDate(row.soldOn)}</td>
              <td>
                {row.instrument}
                <span className="block text-xs text-muted">hankittu {fiDate(row.acquiredOn)}</span>
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
                {/* The rejected method's figure, so the choice is visible
                    rather than asserted. */}
                <span className="block text-xs text-muted">
                  {row.method === "deemed"
                    ? `todellisella ${eur(row.actualGainEur)}`
                    : `olettamalla ${eur(row.deemedGainEur)}`}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

const Ost = ({ report }: { report: TaxYearView }) => {
  if (report.ost.length === 0) return <Empty>Ei osakesäästötilejä.</Empty>;

  return (
    <>
      {report.ost.map((account) => (
        <div key={account.accountName} className="mb-6">
          <h3 className="font-medium">{account.accountName}</h3>
          <p className="text-sm text-muted">
            {/* Not "what is on the account": this is what has been paid in over
                the account's life, less the capital part of withdrawals, which
                is the figure the 100 000 € cap is measured against. */}
            Talletuksia yhteensä {eur(account.depositedEur)} (nostojen pääomaosuus vähennettynä),
            joten tilaa on jäljellä {eur(account.capRemainingEur)}
            {account.incomplete && (
              <Badge title="Ainakin yhden noston veronalaista osuutta ei voitu laskea, joten sen pääomaosuutta ei ole vähennetty talletuksista. Todellinen luku on tätä pienempi.">
                epätäydellinen
              </Badge>
            )}
          </p>
          {account.withdrawals.length === 0 ? (
            <Empty>Ei nostoja tänä vuonna.</Empty>
          ) : (
            <table className="mt-2 w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-line text-left text-muted">
                  <th className="py-2">Nostettu</th>
                  <th className="text-right">Määrä</th>
                  <th className="text-right">Tilin arvo</th>
                  <th className="text-right">Voitto</th>
                  <th className="text-right">Veronalaista</th>
                </tr>
              </thead>
              <tbody>
                {account.withdrawals.map((row) => (
                  <tr key={`${row.withdrawnOn}-${row.amountEur}`} className="border-b border-line">
                    <td className="py-2">{fiDate(row.withdrawnOn)}</td>
                    <td className="text-right">{eur(row.amountEur)}</td>
                    <td className="text-right">
                      {row.valueEur === null ? "—" : eur(row.valueEur)}
                    </td>
                    <td className="text-right">
                      {row.profitEur === null ? "—" : eur(row.profitEur)}
                    </td>
                    <td className="text-right">
                      {row.taxableEur === null ? (
                        <Badge title={row.blockedBy ?? undefined}>ei laskettavissa</Badge>
                      ) : (
                        eur(row.taxableEur)
                      )}
                    </td>
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
  if (report.dividends.length === 0) return <Empty>Ei osinkoja tänä vuonna.</Empty>;
  const anyMissing = report.dividends.some((row) => !row.withholdingRecorded);

  return (
    <>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-line text-left text-muted">
            <th className="py-2">Maksettu</th>
            <th>Instrumentti</th>
            <th className="text-right">Brutto</th>
            <th className="text-right">Ennakonpidätys</th>
            <th className="text-right">Veronalaista 85 %</th>
          </tr>
        </thead>
        <tbody>
          {report.dividends.map((row) => (
            <tr key={`${row.paidOn}-${row.instrument ?? ""}`} className="border-b border-line">
              <td className="py-2">{fiDate(row.paidOn)}</td>
              <td>{row.instrument ?? "Tuntematon"}</td>
              <td className="text-right">
                {eur(row.grossEur)}
                {!row.withholdingRecorded && (
                  <Badge title="Tiliotteessa ei ole erillistä ennakonpidätystä, joten tämä on tilille saapunut summa. Jos välittäjä pidätti veron, todellinen brutto on tätä suurempi.">
                    netto?
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
          Kumpikaan välittäjä ei erittele osingon ennakonpidätystä tuonnissa, joten brutto on tässä
          sama kuin tilille saapunut summa. Jos vero pidätettiin, veronalainen osuus on suurempi
          kuin yllä.
        </p>
      )}
    </>
  );
};

export const TaxPage = () => {
  const years = useQuery({
    queryKey: ["tax-years"],
    queryFn: () => apiGet("/api/tax/years", TaxYearsSchema),
  });
  const [year, setYear] = useState<number | null>(null);
  const selected = year ?? years.data?.[0] ?? null;

  const report = useQuery({
    queryKey: ["tax", selected],
    queryFn: () => apiGet(`/api/tax?year=${selected}`, TaxYearSchema),
    enabled: selected !== null,
  });

  return (
    <>
      <h1>Verot</h1>
      <p className="text-muted">
        Luvut on laskettu tapahtumistasi. Ne on tarkoitettu esitäytetyn veroilmoituksen
        tarkistamiseen, ei sen korvaamiseen — eikä veron määrää lasketa, koska pääomatulon
        veroprosentti riippuu myös tuloista, joita sovellus ei näe.
      </p>

      {years.isPending && <p>Ladataan…</p>}
      {years.data?.length === 0 && <Empty>Ei verotettavia tapahtumia yhtenäkään vuonna.</Empty>}

      {years.data !== undefined && years.data.length > 0 && (
        <label className="mt-4 block">
          Verovuosi{" "}
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
          <Section title="Luovutukset">
            {report.data.exempt && report.data.disposals.length > 0 && (
              <p className="mb-2 text-sm text-muted">
                Vuoden myynnit yhteensä {eur(report.data.totalSalePriceEur)} — enintään 1 000 €,
                joten voitot ovat verovapaita eivätkä tappiot vähennyskelpoisia.
              </p>
            )}
            <Disposals report={report.data} />
            {!report.data.exempt && report.data.disposals.length > 0 && (
              <p className="mt-2 text-sm">
                Voitot {eur(report.data.gainsEur)}, tappiot {eur(report.data.lossesEur)},
                verotettava {eur(report.data.netEur)}.
                {report.data.lossCarriedIn.length > 0 &&
                  ` Aiemmilta vuosilta käytetty ${eur(report.data.lossesUsedEur)}.`}
              </p>
            )}
            {report.data.lossCarriedOut.length > 0 && (
              <p className="mt-1 text-sm text-muted">
                Siirtyy seuraaville vuosille:{" "}
                {report.data.lossCarriedOut
                  .map((loss) => `${loss.fromYear} ${eur(loss.amountEur)}`)
                  .join(", ")}
              </p>
            )}
          </Section>

          <Section title="Osingot">
            <Dividends report={report.data} />
            {report.data.dividends.length > 0 && (
              <p className="mt-2 text-sm">
                Veronalaista osinkotuloa yhteensä {eur(report.data.dividendTaxableEur)}.
              </p>
            )}
          </Section>

          <Section title="Osakesäästötili">
            <Ost report={report.data} />
          </Section>

          <p className="mt-8 text-xs text-muted">
            Laskettu {report.data.source.transactions} tapahtumasta
            {report.data.source.earliest !== null &&
              `, vanhin ${fiDate(report.data.source.earliest)}`}
            . Jos tapahtumia puuttuu, luvut ovat vajaat — sitä mikään tarkistus ei voi havaita.
          </p>
        </>
      )}
    </>
  );
};

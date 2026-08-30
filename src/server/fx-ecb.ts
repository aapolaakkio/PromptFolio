import { parseCurrency, parseFxRate, EUR, type Currency } from "../core/money.ts";
import type { FetchImpl } from "./prices/types.ts";

/**
 * ECB's SDMX data API, which replaced this project's use of the two flat CSV files at
 * `www.ecb.europa.eu/stats/eurofxref/`.
 *
 * **Why the change, verified live on 2026-08-28.** Both flat files are still served with
 * `200 OK` and `Content-Type: text/csv`, and both are frozen:
 *
 *  - `eurofxref.csv` — newest (and only) row is `14 July 2017`.
 *  - `eurofxref-hist.csv` — newest row is `2010-02-14`, and its cells are placeholders
 *    (`2,1,2,N/A,1,2,...`), not rates. SEK's column reads `2`, which inverts to a rate of
 *    exactly `0.5` EUR per SEK against a true rate near `0.09` — a holding valued through
 *    it came out roughly 5.5x too high, with nothing anywhere reporting an error, because
 *    the response was a perfectly well-formed CSV. The live data lives in the `.zip`
 *    variants of those URLs, which would need an unzip step in the server.
 *
 * The SDMX endpoint needs no unzipping, serves current data (checked: today's rate present),
 * reaches back to 1999, takes a date range, and takes several currencies in one request via
 * `+`. `detail=dataonly` trims the response to the columns actually read here.
 */
export const ECB_DATA_URL = "https://data-api.ecb.europa.eu/service/data/EXR";

/** Daily spot reference rates for `currencies`, from `since` (an ISO date) to the present. */
export const ecbSeriesUrl = (currencies: readonly string[], since: string): string => {
  const key = [...currencies].sort().join("+");
  return `${ECB_DATA_URL}/D.${key}.EUR.SP00.A?format=csvdata&detail=dataonly&startPeriod=${since}`;
};

export type EcbRow = {
  readonly date: string;
  readonly currency: Currency;
  readonly rateEur: number;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** ECB publishes plain decimals and never a negative rate. */
const RATE = /^\d+(\.\d+)?$/;

/**
 * Inverts a rate already scaled by 1e8 (foreign-per-EUR, which is how ECB quotes) into
 * EUR-per-foreign at the same scale, in exact bigint arithmetic with the half-up rounding
 * `core/money.ts` uses everywhere else. 1 EUR = 1.0870 USD inverts to 91_996_320.
 */
export const invertScaledRate = (scaled: bigint): number => {
  const numerator = 10n ** 16n;
  const quotient = numerator / scaled;
  const remainder = numerator % scaled;
  return Number(remainder * 2n >= scaled ? quotient + 1n : quotient);
};

/**
 * Parses the SDMX `csvdata` response: one row per currency per day, with the columns named
 * in the header line rather than positional, since `detail` changes how many there are.
 *
 * A row whose date or value does not parse is skipped rather than failing the response: ECB
 * marks a non-published day with an empty `OBS_VALUE`, and one such day must not discard
 * every other day's good rates. A response with no header at all *does* throw -- that is a
 * malformed download, not a data gap.
 */
export const parseEcbSdmxCsv = (text: string, wanted: ReadonlySet<string>): EcbRow[] => {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  const header = lines[0]?.split(",").map((cell) => cell.trim());
  if (header === undefined) throw new Error("ECB-vastaus on tyhjä");

  const currencyAt = header.indexOf("CURRENCY");
  const dateAt = header.indexOf("TIME_PERIOD");
  const valueAt = header.indexOf("OBS_VALUE");
  if (currencyAt < 0 || dateAt < 0 || valueAt < 0) {
    throw new Error(`ECB-vastauksesta puuttuu odotettu sarake: ${lines[0] ?? ""}`);
  }

  const out: EcbRow[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(",");
    const rawCurrency = cells[currencyAt]?.trim();
    const rawDate = cells[dateAt]?.trim();
    const rawValue = cells[valueAt]?.trim();
    if (rawCurrency === undefined || rawDate === undefined || rawValue === undefined) continue;
    if (!wanted.has(rawCurrency) || rawCurrency === "EUR") continue;
    if (!ISO_DATE.test(rawDate) || !RATE.test(rawValue)) continue;

    const currency = parseCurrency(rawCurrency);
    const { scaled } = parseFxRate(rawValue, currency);
    if (scaled <= 0n) continue;
    out.push({ date: rawDate, currency, rateEur: invertScaledRate(scaled) });
  }
  return out;
};

/**
 * Fetches every `currencies` rate from `since` onward. EUR is dropped before the request:
 * it is the base, has no series of its own, and would make the SDMX key invalid.
 */
export const fetchEcbRates = async (
  fetchImpl: FetchImpl,
  currencies: ReadonlySet<string>,
  since: string,
): Promise<EcbRow[]> => {
  const wanted = new Set([...currencies].filter((currency) => currency !== EUR));
  if (wanted.size === 0) return [];

  const response = await fetchImpl(ecbSeriesUrl([...wanted], since));
  if (!response.ok) {
    throw new Error(`ECB vastasi ${response.status} ${response.statusText}`);
  }
  return parseEcbSdmxCsv(await response.text(), wanted);
};

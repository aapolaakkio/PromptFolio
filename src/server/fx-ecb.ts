import { parseCurrency, parseFxRate, EUR, type Currency } from "../core/money.ts";
import type { FetchImpl } from "./prices/types.ts";

/**
 * ECB's SDMX data API, used instead of the flat CSV files at `www.ecb.europa.eu/stats/eurofxref/`: those are
 * still served with `200 OK` but frozen (`eurofxref.csv` ends 2017; `eurofxref-hist.csv` ends 2010 with placeholder
 * cells: SEK reads `2` against a true ~0.09, so a holding came out ~5.5x too high with no error).
 * SDMX needs no unzipping, has data back to 1999 and takes a date range and several currencies via `+`.
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

/** Inverts a scale-1e8 foreign-per-EUR rate (ECB's quoting) to EUR-per-foreign in exact bigint math, half-up like `core/money.ts`. 1 EUR = 1.0870 USD gives 91_996_320. */
const invertScaledRate = (scaled: bigint): number => {
  const numerator = 10n ** 16n;
  const quotient = numerator / scaled;
  const remainder = numerator % scaled;
  return Number(remainder * 2n >= scaled ? quotient + 1n : quotient);
};

/**
 * Parses the SDMX `csvdata` response (columns named in the header, since `detail` changes their number).
 * A row whose date or value does not parse is skipped: ECB marks a non-published day with an empty `OBS_VALUE`.
 * A response with no header throws: that is a malformed download, not a data gap.
 */
export const parseEcbSdmxCsv = (text: string, wanted: ReadonlySet<string>): EcbRow[] => {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  const header = lines[0]?.split(",").map((cell) => cell.trim());
  if (header === undefined) throw new Error("ECB response is empty");

  const currencyAt = header.indexOf("CURRENCY");
  const dateAt = header.indexOf("TIME_PERIOD");
  const valueAt = header.indexOf("OBS_VALUE");
  if (currencyAt < 0 || dateAt < 0 || valueAt < 0) {
    throw new Error(`The ECB response lacks an expected column: ${lines[0] ?? ""}`);
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

/** Fetches every `currencies` rate from `since`. EUR is dropped first: it is the base and would make the SDMX key invalid. */
export const fetchEcbRates = async (
  fetchImpl: FetchImpl,
  currencies: ReadonlySet<string>,
  since: string,
): Promise<EcbRow[]> => {
  const wanted = new Set([...currencies].filter((currency) => currency !== EUR));
  if (wanted.size === 0) return [];

  const response = await fetchImpl(ecbSeriesUrl([...wanted], since));
  if (!response.ok) {
    throw new Error(`ECB answered ${response.status} ${response.statusText}`);
  }
  return parseEcbSdmxCsv(await response.text(), wanted);
};

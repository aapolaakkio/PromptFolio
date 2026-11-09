import { z } from "zod";

export type InstrumentKind = "stock" | "etf" | "fund";

/**
 * OpenFIGI's ISIN mapping (`POST https://api.openfigi.com/v3/mapping`, no key; the unauthenticated
 * tier is rate-limited, so once per instrument). Fixtures: `fixtures/figi-*.json`. It covers Finnish
 * non-listed funds (`FI4000261128` is `OP-WORLD INDEX FUND-A EUR`, "Open-End Fund"). A listed security
 * returns one row per venue with a shared `securityType`; only type and name are read, the ticker is
 * left to Yahoo. Failures are `200 OK` with an object instead of `data`: `{"error":...}` (malformed
 * ISIN) or `{"warning":"No identifier found."}`; both mean "no answer".
 */
const MappingResponse = z
  .array(
    z.union([
      z.object({
        data: z
          .array(
            z.object({
              name: z.string().optional(),
              securityType: z.string().optional(),
              securityType2: z.string().optional(),
              ticker: z.string().optional(),
              exchCode: z.string().optional(),
            }),
          )
          .min(1),
      }),
      z.object({ error: z.string() }),
      z.object({ warning: z.string() }),
    ]),
  )
  .min(1);

// `securityType`, not `securityType2`: the latter reports the IWDA ETF as "Mutual Fund", sending a tradeable ETF to the wrong price source.
const KIND_BY_SECURITY_TYPE = new Map<string, InstrumentKind>([
  ["Common Stock", "stock"],
  ["Preference Stock", "stock"],
  ["Depositary Receipt", "stock"],
  ["REIT", "stock"],
  ["ETP", "etf"],
  ["Open-End Fund", "fund"],
  ["Closed-End Fund", "fund"],
  ["Fund of Funds", "fund"],
  ["Mutual Fund", "fund"],
]);

type FigiResult = {
  readonly name: string | null;
  readonly kind: InstrumentKind;
  /** One entry per venue, deduplicated by exchange (IWDA has 180 rows): lets a caller find the listing in the holding's currency. */
  readonly venues: readonly { readonly ticker: string; readonly exchCode: string }[];
};

/** Resolves an ISIN to registry name and kind, or `null`; unknown or malformed ISINs are ordinary outcomes, never thrown. */
export const figiLookup = async (
  isin: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FigiResult | null> => {
  const response = await fetchImpl("https://api.openfigi.com/v3/mapping", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([{ idType: "ID_ISIN", idValue: isin }]),
  });
  if (!response.ok) return null;

  const parsed = MappingResponse.safeParse(await response.json());
  if (!parsed.success) return null;
  const first = parsed.data[0]!;
  if (!("data" in first)) return null;

  const row = first.data[0]!;
  const kind =
    row.securityType === undefined ? undefined : KIND_BY_SECURITY_TYPE.get(row.securityType);
  if (kind === undefined) return null;

  const byExchange = new Map<string, string>();
  for (const candidate of first.data) {
    if (candidate.ticker === undefined || candidate.exchCode === undefined) continue;
    if (!byExchange.has(candidate.exchCode)) byExchange.set(candidate.exchCode, candidate.ticker);
  }

  return {
    name: row.name ?? null,
    kind,
    venues: [...byExchange].map(([exchCode, ticker]) => ({ exchCode, ticker })),
  };
};

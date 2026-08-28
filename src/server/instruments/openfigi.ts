import { z } from "zod";

export type InstrumentKind = "stock" | "etf" | "fund";

/**
 * OpenFIGI's ISIN mapping, verified 2026-08-28 against the live
 * `POST https://api.openfigi.com/v3/mapping` (no API key, no auth -- the
 * unauthenticated tier is rate-limited, which is why lookups happen once per
 * instrument at registration and never in a loop). Recorded responses are in
 * `fixtures/figi-*.json`. What the live calls established:
 *
 *  - Its coverage includes Finnish non-listed funds: `FI4000261128` resolves
 *    to `OP-WORLD INDEX FUND-A EUR`, `securityType: "Open-End Fund"`.
 *  - A listed security returns one row per venue -- Nokia 3+, Ericsson 179,
 *    IWDA 180 -- all sharing a `securityType`. Only the type and the name are
 *    read here; picking a venue's ticker is deliberately left to Yahoo, whose
 *    symbols are what the price fetcher actually needs.
 *  - Two distinct failure shapes, both `200 OK` with an object in place of
 *    `data`: `{"error":"Invalid idValue format."}` for a malformed ISIN or a
 *    bad check digit, and `{"warning":"No identifier found."}` for a
 *    well-formed ISIN that is not in the registry. Neither is an exception
 *    here -- both mean "no answer", and the caller falls back to the form.
 *
 * This exists alongside Yahoo's search rather than instead of it because the
 * two answer different questions: Yahoo's search result carries the ticker
 * but no security type, and OpenFIGI carries the type but no venue the price
 * fetcher can use.
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
            }),
          )
          .min(1),
      }),
      z.object({ error: z.string() }),
      z.object({ warning: z.string() }),
    ]),
  )
  .min(1);

/**
 * `securityType` values seen live, mapped to instruments.kind. `securityType`
 * is used rather than `securityType2` because the latter reports IWDA -- an
 * ETF -- as `"Mutual Fund"`, which would register a tradeable ETF as a
 * non-listed fund and send it to the wrong price source.
 */
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

export type FigiResult = { readonly name: string | null; readonly kind: InstrumentKind };

/**
 * Resolves an ISIN to its registry name and kind, or `null` when the registry
 * has no usable answer. Never throws for an unknown or malformed ISIN: those
 * are ordinary outcomes that hand control back to the manual form.
 */
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
  return { name: row.name ?? null, kind };
};

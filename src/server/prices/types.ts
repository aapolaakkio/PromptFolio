import type { Currency } from "../../core/money";
import type { PriceSourceId } from "../../core/types";

/**
 * One dated close/NAV as a source actually reported it. `currency` is
 * whatever the source observed -- never assumed to be EUR. Confirmed
 * necessary against a real holding: the user's SE0002756973 (Nordnet
 * Sverige Index) NAV is quoted in SEK, not EUR (see funds.ts's
 * NORDNET_FUND comment). Conversion to EUR is a later layer's job (not
 * this task's), so it is never done here.
 */
export type FetchedPrice = {
  readonly date: string;
  readonly closeMinor: number;
  readonly currency: Currency;
};

/**
 * Just the callable shape of global `fetch`, not `typeof fetch` itself --
 * Bun's own type for `fetch` additionally requires a static `preconnect`
 * method, which no plain stub function has, so `typeof fetch` cannot be
 * satisfied by a test's `async () => new Response(...)`. Only the call
 * signature is ever used by any `PriceSource`, so this is what every
 * `fetchImpl` (including the real `fetch` used as its default) is typed
 * against.
 */
export type FetchImpl = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type FetchArgs = {
  readonly sourceKey: string;
  readonly from: string;
  readonly to: string;
  readonly fetchImpl?: FetchImpl;
};

export type PriceSource = {
  readonly id: PriceSourceId;
  fetch(args: FetchArgs): Promise<FetchedPrice[]>;
};

/**
 * Converts a plain JS float (as returned by a JSON API, e.g. Yahoo's
 * `close`) into integer minor units. Only safe to within ordinary
 * floating-point precision at two decimal places -- for a source that
 * hands back the NAV as *text* instead (the Nordnet/OP fund pages both
 * do), prefer `parseMoney` from `core/money` on that text directly, which
 * does exact decimal-string arithmetic and has no float step at all.
 */
export const toMinor = (value: number): number => Math.round(value * 100);

export const requireOk = async (response: Response, label: string): Promise<Response> => {
  if (!response.ok) {
    throw new Error(`${label} vastasi ${response.status} ${response.statusText}`);
  }
  return response;
};

/** `date` is within `[from, to]`, both inclusive, as plain ISO-date string compares. */
export const inRange = (date: string, from: string, to: string): boolean =>
  date >= from && date <= to;

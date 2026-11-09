import type { Currency } from "../../core/money.ts";
import type { PriceSourceId } from "../../core/types.ts";

/** One dated close. The currency is what the source observed, never assumed EUR (a fund may quote SEK). */
export type FetchedPrice = {
  readonly date: string;
  readonly closeMinor: number;
  readonly currency: Currency;
};

/** The callable shape of `fetch`, since `typeof fetch` has static members no stub has. */
export type FetchImpl = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** The URL a `FetchImpl` was called with; `String(request)` is "[object Request]", so a URL-matching stub would silently stop matching. */
export const urlOf = (input: string | URL | Request): string =>
  input instanceof Request ? input.url : String(input);

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

/** A JSON API's float to minor units, safe only to ordinary float precision; text sources should use `parseMoney`. */
export const toMinor = (value: number): number => Math.round(value * 100);

export const requireOk = async (response: Response, label: string): Promise<Response> => {
  if (!response.ok) {
    throw new Error(`${label} answered ${response.status} ${response.statusText}`);
  }
  return response;
};

/**
 * Refuses a close that is never a real price: zero would value a holding at nothing. No jump
 * threshold, as one fetch has no prior price. Past MAX_SAFE_INTEGER is refused too, being the
 * only ceiling a mistyped manual price meets (it bypasses the jump guard).
 */
export const requirePositiveMinor = (closeMinor: number, label: string): number => {
  if (!(closeMinor > 0)) {
    throw new Error(`${label}: invalid price ${closeMinor} (zero or negative)`);
  }
  if (!Number.isSafeInteger(closeMinor)) {
    throw new Error(`${label}: invalid price ${closeMinor} (too large to store exactly)`);
  }
  return closeMinor;
};

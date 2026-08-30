import type { Currency } from "../../core/money.ts";
import type { PriceSourceId } from "../../core/types.ts";

/**
 * One dated close as a source reported it. The currency is whatever the source
 * observed, never assumed to be EUR -- a real fund quotes its NAV in SEK.
 * Converting is a later layer's job.
 */
export type FetchedPrice = {
  readonly date: string;
  readonly closeMinor: number;
  readonly currency: Currency;
};

/**
 * The callable shape of `fetch`, not `typeof fetch`: that carries static members
 * no stub has, so a test's plain async function could never satisfy it.
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
 * A JSON API's float into integer minor units, safe only to ordinary float
 * precision. A source handing back text should go through `parseMoney` instead,
 * which is exact and has no float step.
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

/**
 * Refuses a close that is never a real price. Every source passed a zero straight
 * through before this existed, which would value a holding at nothing and drag
 * the whole total down.
 *
 * Not a "suspiciously large jump" check: no threshold there is a fact rather than
 * a guess, and this sees one fetch with no prior price to compare against.
 *
 * A value past `Number.MAX_SAFE_INTEGER` is refused too, which is a fact about
 * floating point rather than about markets: manual entry bypasses the downstream
 * jump guard, so this is the only ceiling a mistyped price ever meets.
 */
export const requirePositiveMinor = (closeMinor: number, label: string): number => {
  if (!(closeMinor > 0)) {
    throw new Error(`${label}: epäkelpo hinta ${closeMinor} (nolla tai negatiivinen)`);
  }
  if (!Number.isSafeInteger(closeMinor)) {
    throw new Error(
      `${label}: epäkelpo hinta ${closeMinor} (liian suuri tallennettavaksi tarkasti)`,
    );
  }
  return closeMinor;
};

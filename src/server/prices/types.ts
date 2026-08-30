import type { Currency } from "../../core/money.ts";
import type { PriceSourceId } from "../../core/types.ts";

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

/**
 * A zero or negative close/NAV is never a real price -- no listed security
 * or fund unit trades at or below zero. Reproduced live against all three
 * real sources during review (`OP_FUND` with `0,00 EUR`, `NORDNET_FUND`
 * with `"value":0`, `YAHOO` with `close: [0]` and `close: [-5]`): every one
 * of them passed the bogus value straight through as a `FetchedPrice`
 * before this check existed. A zero NAV would silently value a holding at
 * nothing and drag the whole portfolio total down; a negative one is
 * nonsense that would flow straight into the growth chart -- exactly the
 * "never yield a plausible wrong number" failure this task is written
 * against. Every source calls this at the point it builds a
 * `FetchedPrice`, so a bad value fails the whole fetch loudly instead of
 * being returned as one wrong point among otherwise-good ones.
 *
 * Deliberately does **not** also reject a "suspiciously large" jump: unlike
 * zero/negative, there is no threshold that is a fact rather than a guess
 * -- a real overnight move (a split, a large dividend adjustment, a
 * genuine crash) can legitimately be large, and this module sees one
 * fetch at a time with no prior price to compare against. Inventing a
 * percentage here would be exactly the kind of unverified guess this task
 * exists to avoid; that check belongs at a layer with historical context
 * (Task 15's reconciliation/stale-badge work), not here.
 *
 * Does reject a value too large for `Number` to represent exactly, unconditionally --
 * unlike the "suspiciously large" percentage jump above, this is not a guess about market
 * behaviour, it is a fact about floating-point: past `Number.MAX_SAFE_INTEGER` an integer
 * minor-unit amount can silently lose precision, and every caller of this function
 * eventually stores the result in an INTEGER column and multiplies it into a `Money`. For
 * every caller with a plausibility guard downstream (`write.ts`'s jump check) this is
 * unreachable in practice, but the manual-entry API route deliberately bypasses that guard
 * (a human correction must not be blocked by it -- see `api/prices.ts`), which makes this
 * the *only* ceiling a mistyped, absurdly long price (e.g. a stray extra digit or a
 * pasted-in decimal typo) ever meets.
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

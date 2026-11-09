/**
 * A validated ISO 4217 code, branded so it only comes from `parseCurrency`. The brand does not
 * encode minor units: `MONEY_SCALE = 2` assumes 2 decimals (wrong for JPY, KWD).
 */
export type Currency = string & { readonly __brand: "Currency" };

const ISO_4217_PATTERN = /^[A-Z]{3}$/;

/** Validates the ISO 4217 shape (three uppercase A-Z letters). Rejects anything else. */
export const parseCurrency = (text: string): Currency => {
  if (!ISO_4217_PATTERN.test(text)) {
    throw new Error(`Not an ISO 4217 currency code: ${JSON.stringify(text)}`);
  }
  // SAFETY: `text` just matched ISO_4217_PATTERN.
  return text as Currency;
};

/** The base currency. */
export const EUR: Currency = parseCurrency("EUR");

type Rounding = "half-up" | "floor";

export type Money = { readonly minor: bigint; readonly currency: Currency };
export type Quantity = { readonly scaled: bigint };
export type FxRate = { readonly scaled: bigint; readonly currency: Currency };

const MONEY_SCALE = 2;
const QUANTITY_SCALE = 6;
const FX_SCALE = 8;

const QUANTITY_UNIT = 10n ** BigInt(QUANTITY_SCALE);
const FX_UNIT = 10n ** BigInt(FX_SCALE);

export const money = (minor: bigint, currency: Currency): Money => ({ minor, currency });
export const zeroMoney = (currency: Currency): Money => ({ minor: 0n, currency });

/** Parses "1 234,56", "1234.56", "-0,07". Rejects anything else. Rounds extra decimals half-up. */
const parseScaled = (text: string, scale: number): bigint => {
  const cleaned = text.replace(/[\s ]/g, "").replace(",", ".");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) {
    throw new Error(`Not a decimal number: ${JSON.stringify(text)}`);
  }
  const negative = cleaned.startsWith("-");
  const [whole = "0", frac = ""] = cleaned.replace("-", "").split(".");
  const padded = (frac + "0".repeat(scale + 1)).slice(0, scale + 1);
  const scaledUp = BigInt(whole + padded.slice(0, scale));
  const roundUp = Number(padded[scale]) >= 5 ? 1n : 0n;
  const value = scaledUp + roundUp;
  return negative ? -value : value;
};

export const parseMoney = (text: string, currency: Currency): Money => ({
  minor: parseScaled(text, MONEY_SCALE),
  currency,
});

export const parseQuantity = (text: string): Quantity => ({
  scaled: parseScaled(text, QUANTITY_SCALE),
});

export const parseFxRate = (text: string, currency: Currency): FxRate => ({
  scaled: parseScaled(text, FX_SCALE),
  currency,
});

const formatScaled = (value: bigint, scale: number): string => {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  const frac = digits.slice(digits.length - scale);
  return `${negative ? "-" : ""}${whole}.${frac}`;
};

export const formatMoney = (m: Money): string => formatScaled(m.minor, MONEY_SCALE);
export const formatQuantity = (q: Quantity): string => formatScaled(q.scaled, QUANTITY_SCALE);

const sameCurrency = (a: Money, b: Money): void => {
  if (a.currency !== b.currency) {
    throw new Error(`Currency mismatch: ${a.currency} vs ${b.currency}`);
  }
};

export const addMoney = (a: Money, b: Money): Money => {
  sameCurrency(a, b);
  return { minor: a.minor + b.minor, currency: a.currency };
};

export const subMoney = (a: Money, b: Money): Money => {
  sameCurrency(a, b);
  return { minor: a.minor - b.minor, currency: a.currency };
};

export const negateMoney = (m: Money): Money => ({ minor: -m.minor, currency: m.currency });

/** bigint division; `half-up` rounds ties away from zero, `floor` toward negative infinity. */
const divideRounded = (value: bigint, divisor: bigint, mode: Rounding): bigint => {
  if (divisor === 0n) throw new Error("Division by zero");
  const negative = value < 0n !== divisor < 0n;
  const a = value < 0n ? -value : value;
  const b = divisor < 0n ? -divisor : divisor;
  const q = a / b;
  const r = a % b;
  if (mode === "half-up") {
    const rounded = r * 2n >= b ? q + 1n : q;
    return negative ? -rounded : rounded;
  }
  if (negative && r !== 0n) return -(q + 1n);
  return negative ? -q : q;
};

export const mulMoney = (m: Money, q: Quantity, mode: Rounding = "half-up"): Money => ({
  minor: divideRounded(m.minor * q.scaled, QUANTITY_UNIT, mode),
  currency: m.currency,
});

export const divMoney = (m: Money, divisor: bigint, mode: Rounding = "half-up"): Money => ({
  minor: divideRounded(m.minor, divisor, mode),
  currency: m.currency,
});

export const addQuantity = (a: Quantity, b: Quantity): Quantity => ({
  scaled: a.scaled + b.scaled,
});
export const subQuantity = (a: Quantity, b: Quantity): Quantity => ({
  scaled: a.scaled - b.scaled,
});
export const isZeroQuantity = (q: Quantity): boolean => q.scaled === 0n;
export const cmpQuantity = (a: Quantity, b: Quantity): number =>
  a.scaled === b.scaled ? 0 : a.scaled < b.scaled ? -1 : 1;

export const toEur = (m: Money, rate: FxRate, mode: Rounding = "half-up"): Money => {
  if (m.currency === EUR) return m;
  if (rate.currency !== m.currency) {
    throw new Error(
      `Fx rate currency ${rate.currency} does not match amount currency ${m.currency}`,
    );
  }
  return {
    minor: divideRounded(m.minor * rate.scaled, FX_UNIT, mode),
    currency: EUR,
  };
};

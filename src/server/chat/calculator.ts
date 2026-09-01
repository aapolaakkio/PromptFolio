/**
 * Exact arithmetic for the assistant.
 *
 * The rule this replaces was absolute: every figure had to come from a tool,
 * because a model doing sums in prose is a model that eventually states a
 * confident wrong euro amount. The owner asked for the freedom; this is how it
 * is given without giving up the exactness.
 *
 * Everything is computed in hundredths as integers, the same discipline the
 * ledger uses. A model asking for 0,1 + 0,2 gets 0,30, not 0,30000000000000004,
 * and a percentage of a sum is the percentage of that exact sum. The model still
 * chooses what to calculate -- it simply does not do the calculating.
 */

type CalcOperation = "sum" | "subtract" | "multiply" | "divide" | "percent" | "average";

export type CalcRequest = {
  readonly operation: CalcOperation;
  /** Decimal strings, never JSON numbers -- the wire rule money follows everywhere. */
  readonly values: readonly string[];
};

export type CalcResult = {
  readonly operation: CalcOperation;
  readonly values: readonly string[];
  readonly result: string;
  /** The arithmetic written out, so an answer can show its working. */
  readonly working: string;
};

const SCALE = 100n;

/** A decimal string to hundredths. Rejects anything that is not a plain number. */
const toMinor = (text: string): bigint => {
  const cleaned = text.trim().replace(/\s/g, "").replace(",", ".");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) {
    throw new Error(`Luku ei kelpaa: "${text}". Käytä muotoa 1234.56`);
  }
  const negative = cleaned.startsWith("-");
  const [whole = "0", fraction = ""] = cleaned.replace("-", "").split(".");
  // Rounded half-up at two decimals rather than truncated: a third of a euro
  // asked for in cents is 0,33, and silently dropping the rest would make a
  // division and its inverse disagree.
  const padded = `${fraction}00`.slice(0, 3);
  const hundredths = BigInt(whole) * SCALE + BigInt(padded.slice(0, 2));
  const rounded = Number(padded[2] ?? "0") >= 5 ? hundredths + 1n : hundredths;
  return negative ? -rounded : rounded;
};

const toDecimal = (minor: bigint): string => {
  const negative = minor < 0n;
  const absolute = negative ? -minor : minor;
  const whole = absolute / SCALE;
  const cents = absolute % SCALE;
  return `${negative ? "-" : ""}${whole}.${cents.toString().padStart(2, "0")}`;
};

const divideRounded = (numerator: bigint, denominator: bigint): bigint => {
  if (denominator === 0n) throw new Error("Nollalla ei voi jakaa");
  // Half-up on the magnitude, so -0,005 and 0,005 round the same distance from
  // zero rather than one of them drifting.
  const negative = numerator < 0n !== denominator < 0n;
  const a = numerator < 0n ? -numerator : numerator;
  const b = denominator < 0n ? -denominator : denominator;
  const quotient = (a * 2n + b) / (b * 2n);
  return negative ? -quotient : quotient;
};

/**
 * Runs one calculation over decimal strings.
 *
 * Deliberately small: sums, differences, products, quotients, percentages and
 * averages are what a question about money needs. Anything more elaborate is
 * better answered by a tool that reads the ledger than by arithmetic on figures
 * the model happens to be holding.
 */
export const calculate = (request: CalcRequest): CalcResult => {
  const minors = request.values.map(toMinor);
  const first = minors[0];
  if (first === undefined) throw new Error("Anna vähintään yksi luku");

  const result = ((): bigint => {
    switch (request.operation) {
      case "sum":
        return minors.reduce((total, value) => total + value, 0n);
      case "subtract":
        return minors.slice(1).reduce((total, value) => total - value, first);
      case "multiply":
        // One factor is money, the rest are plain multipliers, so the product is
        // divided back down by the scale each time.
        return minors.slice(1).reduce((total, value) => divideRounded(total * value, SCALE), first);
      case "divide":
        return minors.slice(1).reduce((total, value) => divideRounded(total * SCALE, value), first);
      case "percent": {
        const [amount, share] = minors;
        if (amount === undefined || share === undefined) {
          throw new Error("percent tarvitsee kaksi lukua: summa ja prosentti");
        }
        return divideRounded(amount * share, SCALE * 100n);
      }
      case "average":
        return divideRounded(
          minors.reduce((total, value) => total + value, 0n),
          BigInt(minors.length),
        );
    }
  })();

  const symbols = {
    sum: " + ",
    subtract: " - ",
    multiply: " × ",
    divide: " ÷ ",
    percent: " % of ",
    average: ", ",
  } satisfies Record<CalcOperation, string>;
  const shown =
    request.operation === "average"
      ? `keskiarvo(${request.values.join(", ")})`
      : request.operation === "percent"
        ? `${request.values[1] ?? ""} % luvusta ${request.values[0] ?? ""}`
        : request.values.join(symbols[request.operation]);

  return {
    operation: request.operation,
    values: request.values,
    result: toDecimal(result),
    working: `${shown} = ${toDecimal(result)}`,
  };
};

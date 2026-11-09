// Exact arithmetic for the assistant, in integer hundredths like the ledger: 0,1 + 0,2 gives 0,30.

type CalcOperation = "sum" | "subtract" | "multiply" | "divide" | "percent" | "average";

type CalcRequest = {
  readonly operation: CalcOperation;
  readonly values: readonly string[];
};

type CalcResult = {
  readonly operation: CalcOperation;
  readonly values: readonly string[];
  readonly result: string;
  readonly working: string;
};

const SCALE = 100n;

const toMinor = (text: string): bigint => {
  const cleaned = text.trim().replace(/\s/g, "").replace(",", ".");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) {
    throw new Error(`Invalid number: "${text}". Use the form 1234.56`);
  }
  const negative = cleaned.startsWith("-");
  const [whole = "0", fraction = ""] = cleaned.replace("-", "").split(".");
  // Half-up, not truncated, so a division and its inverse agree.
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
  if (denominator === 0n) throw new Error("Cannot divide by zero");
  // Half-up on the magnitude, so -0,005 and 0,005 round alike.
  const negative = numerator < 0n !== denominator < 0n;
  const a = numerator < 0n ? -numerator : numerator;
  const b = denominator < 0n ? -denominator : denominator;
  const quotient = (a * 2n + b) / (b * 2n);
  return negative ? -quotient : quotient;
};

/** Sums, differences, products, quotients, percentages and averages over decimal strings. */
export const calculate = (request: CalcRequest): CalcResult => {
  const minors = request.values.map(toMinor);
  const first = minors[0];
  if (first === undefined) throw new Error("Give at least one number");

  const result = ((): bigint => {
    switch (request.operation) {
      case "sum":
        return minors.reduce((total, value) => total + value, 0n);
      case "subtract":
        return minors.slice(1).reduce((total, value) => total - value, first);
      case "multiply":
        // One factor is money, the rest plain multipliers, so divide the scale back down each time.
        return minors.slice(1).reduce((total, value) => divideRounded(total * value, SCALE), first);
      case "divide":
        return minors.slice(1).reduce((total, value) => divideRounded(total * SCALE, value), first);
      case "percent": {
        const [amount, share] = minors;
        if (amount === undefined || share === undefined) {
          throw new Error("percent needs two numbers: the amount and the percentage");
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
      ? `average(${request.values.join(", ")})`
      : request.operation === "percent"
        ? `${request.values[1] ?? ""} % of ${request.values[0] ?? ""}`
        : request.values.join(symbols[request.operation]);

  return {
    operation: request.operation,
    values: request.values,
    result: toDecimal(result),
    working: `${shown} = ${toDecimal(result)}`,
  };
};

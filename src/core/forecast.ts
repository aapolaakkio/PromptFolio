// A forecast is an estimate, so amounts are plain numbers here, rounded to cents only in the result.

export type ForecastHolding = {
  readonly id: string;
  readonly name: string;
  readonly valueEur: number;
  /** Expected yearly growth as a decimal (0.06 = 6 %). */
  readonly rate: number;
  /** Yearly standard deviation as a decimal. */
  readonly volatility: number;
};

export type ForecastContribution = {
  readonly holdingId: string;
  readonly monthlyEur: number;
  /** First month index it pays in (default 1). */
  readonly fromMonth?: number;
  /** Last month index it pays in (default: the horizon). */
  readonly toMonth?: number;
  /** Raise once every 12 months, as a decimal. */
  readonly yearlyIncrease?: number;
};

/** Positive = deposit, negative = withdrawal; a null holding spreads pro rata to value. */
export type ForecastEvent = {
  readonly month: number;
  readonly holdingId: string | null;
  readonly amountEur: number;
};

/** `change` −0.5 halves the holding (or every holding, when null) that month. */
export type ForecastShock = {
  readonly month: number;
  readonly holdingId: string | null;
  readonly change: number;
};

export type ForecastScenario = {
  /** ISO month, YYYY-MM: month index 0. */
  readonly startDate: string;
  /** Horizon in months, 1…600. */
  readonly months: number;
  readonly holdings: readonly ForecastHolding[];
  readonly contributions?: readonly ForecastContribution[];
  readonly events?: readonly ForecastEvent[];
  readonly shocks?: readonly ForecastShock[];
  /** Yearly, default 0.02. */
  readonly inflation?: number;
  /** Today's euros (default true) or nominal. */
  readonly real?: boolean;
};

export type ForecastBand = {
  readonly low: number;
  readonly expected: number;
  readonly high: number;
};

export type ForecastPoint = {
  readonly index: number;
  readonly month: string;
  readonly total: ForecastBand;
  readonly holdings: readonly (ForecastBand & { readonly id: string })[];
  /** Money put in since the start (contributions and events, net), in the same euros as the values. */
  readonly contributedEur: number;
};

export type ForecastShortfall = {
  readonly month: number;
  readonly holdingId: string | null;
  readonly shortfallEur: number;
};

export type ForecastResult = {
  readonly points: readonly ForecastPoint[];
  /** Withdrawals capped because the holding ran out. */
  readonly shortfalls: readonly ForecastShortfall[];
  readonly real: boolean;
  readonly inflation: number;
};

export type ForecastPath = keyof ForecastBand;

export const MAX_FORECAST_MONTHS = 600;
export const DEFAULT_INFLATION = 0.02;
const Z_90 = 1.2816;
const MAX_MONTHLY_CENTS = 10_000_000_000;

const cents = (value: number): number => Math.round(value * 100) / 100;

const monthLabel = (start: string, offset: number): string => {
  const [year = 0, month = 1] = start.split("-").map(Number);
  const at = year * 12 + (month - 1) + offset;
  return `${Math.floor(at / 12)}-${String((at % 12) + 1).padStart(2, "0")}`;
};

/**
 * Tranche value at the p-quantile after t years, relative to its expected (mean) value:
 * lognormal with μ = ln(1+r), so value·exp((μ − σ²/2)·t + z·σ·√t) ÷ value·(1+r)^t = exp(−σ²t/2 + z·σ·√t).
 */
const quantileFactor = (sigma: number, years: number, z: number): number =>
  Math.exp((-sigma * sigma * years) / 2 + z * sigma * Math.sqrt(years));

/** One holding's state: each tranche's base times a running scale is its expected value now. */
type Book = {
  scale: number;
  baseSum: number;
  readonly tranches: { readonly month: number; readonly base: number }[];
  /** Quantile factors by tranche age in months, computed once: `exp` per tranche per month is too slow at 600 months. */
  readonly low: readonly number[];
  readonly high: readonly number[];
};

const factorsBy = (sigma: number, months: number, z: number): number[] =>
  Array.from({ length: months + 1 }, (_, age) => quantileFactor(sigma, age / 12, z));

const valueOf = (book: Book): number => book.scale * book.baseSum;

const addTranche = (book: Book, month: number, amount: number): void => {
  if (amount <= 0) return;
  const base = amount / book.scale;
  book.tranches.push({ month, base });
  book.baseSum += base;
};

const rescale = (book: Book, factor: number): void => {
  if (factor > 0) {
    book.scale *= factor;
    return;
  }
  // Emptied: nothing left to scale, so start over with no tranches.
  book.scale = 1;
  book.baseSum = 0;
  book.tranches.length = 0;
};

/**
 * Low/high sum each tranche's own quantile: tranches and holdings are treated as perfectly correlated.
 * The high factor is floored at 1 so the band always contains the mean (the lognormal median falls below it at long horizons).
 */
// ponytail: comonotone sum overstates the band width (diversification ignored); the UI calls it "a rough range".
const bandOf = (book: Book, month: number, sigma: number): ForecastBand => {
  const expected = valueOf(book);
  if (sigma === 0) return { low: expected, expected, high: expected };
  const sums = book.tranches.reduce(
    (acc, tranche) => ({
      low: acc.low + tranche.base * (book.low[month - tranche.month] ?? 1),
      high: acc.high + tranche.base * Math.max(1, book.high[month - tranche.month] ?? 1),
    }),
    { low: 0, high: 0 },
  );
  return {
    low: Math.min(expected, book.scale * sums.low),
    expected,
    high: Math.max(expected, book.scale * sums.high),
  };
};

const contributionAt = (row: ForecastContribution, month: number, horizon: number): number => {
  const from = row.fromMonth ?? 1;
  if (month < from || month > (row.toMonth ?? horizon)) return 0;
  return row.monthlyEur * (1 + (row.yearlyIncrease ?? 0)) ** Math.floor((month - from) / 12);
};

type EventOutcome = { readonly moved: number; readonly shortfall: ForecastShortfall | null };

/** Applies one event and returns the money actually moved and any shortfall. */
const applyEvent = (
  books: ReadonlyMap<string, Book>,
  event: ForecastEvent,
  month: number,
): EventOutcome => {
  const targets =
    event.holdingId === null
      ? [...books.values()]
      : [books.get(event.holdingId)].filter((book) => book !== undefined);
  const total = targets.reduce((sum, book) => sum + valueOf(book), 0);
  if (event.amountEur >= 0) {
    targets.forEach((book) =>
      addTranche(
        book,
        month,
        event.amountEur * (total > 0 ? valueOf(book) / total : 1 / targets.length),
      ),
    );
    return { moved: targets.length > 0 ? event.amountEur : 0, shortfall: null };
  }
  const wanted = -event.amountEur;
  const taken = Math.min(wanted, total);
  if (total > 0) targets.forEach((book) => rescale(book, 1 - taken / total));
  const short = wanted - taken;
  return {
    moved: -taken,
    shortfall: short > 0 ? { month, holdingId: event.holdingId, shortfallEur: cents(short) } : null,
  };
};

type Run = { readonly points: ForecastPoint[]; readonly shortfalls: ForecastShortfall[] };

const pointAt = (
  scenario: ForecastScenario,
  books: ReadonlyMap<string, Book>,
  month: number,
  contributed: number,
  withBands: boolean,
): ForecastPoint => {
  const deflator =
    (scenario.real ?? true) ? (1 + (scenario.inflation ?? DEFAULT_INFLATION)) ** (month / 12) : 1;
  const raw = scenario.holdings.map((holding) => {
    // SAFETY: every holding has a book, built from the same list.
    const book = books.get(holding.id) as Book;
    const band = withBands
      ? bandOf(book, month, holding.volatility)
      : { low: valueOf(book), expected: valueOf(book), high: valueOf(book) };
    return { id: holding.id, ...band };
  });
  const sum = (key: ForecastPath) => cents(raw.reduce((acc, row) => acc + row[key], 0) / deflator);
  return {
    index: month,
    month: monthLabel(scenario.startDate, month),
    total: { low: sum("low"), expected: sum("expected"), high: sum("high") },
    holdings: raw.map((row) => ({
      id: row.id,
      low: cents(row.low / deflator),
      expected: cents(row.expected / deflator),
      high: cents(row.high / deflator),
    })),
    contributedEur: cents(contributed / deflator),
  };
};

const stepMonth = (scenario: ForecastScenario, books: ReadonlyMap<string, Book>, month: number) => {
  scenario.holdings.forEach((holding) => {
    // SAFETY: every holding has a book, built from the same list.
    const book = books.get(holding.id) as Book;
    rescale(book, (1 + holding.rate) ** (1 / 12));
    (scenario.shocks ?? [])
      .filter((shock) => shock.month === month)
      .filter((shock) => shock.holdingId === null || shock.holdingId === holding.id)
      .forEach((shock) => rescale(book, 1 + shock.change));
  });
  const paid = (scenario.contributions ?? []).reduce((sum, row) => {
    const book = books.get(row.holdingId);
    const amount = book === undefined ? 0 : contributionAt(row, month, scenario.months);
    if (book !== undefined) addTranche(book, month, amount);
    return sum + amount;
  }, 0);
  const moves = (scenario.events ?? [])
    .filter((event) => event.month === month)
    .map((event) => applyEvent(books, event, month));
  return {
    paid: paid + moves.reduce((sum, move) => sum + move.moved, 0),
    shortfalls: moves.flatMap((move) => (move.shortfall === null ? [] : [move.shortfall])),
  };
};

const simulate = (scenario: ForecastScenario, withBands: boolean): Run => {
  const books = new Map<string, Book>(
    scenario.holdings.map((holding) => {
      const sigma = withBands ? holding.volatility : 0;
      const book: Book = {
        scale: 1,
        baseSum: 0,
        tranches: [],
        low: sigma === 0 ? [] : factorsBy(sigma, scenario.months, -Z_90),
        high: sigma === 0 ? [] : factorsBy(sigma, scenario.months, Z_90),
      };
      addTranche(book, 0, holding.valueEur);
      return [holding.id, book];
    }),
  );
  const points = [pointAt(scenario, books, 0, 0, withBands)];
  const shortfalls: ForecastShortfall[] = [];
  let contributed = 0;
  for (let month = 1; month <= scenario.months; month += 1) {
    const step = stepMonth(scenario, books, month);
    contributed += step.paid;
    shortfalls.push(...step.shortfalls);
    points.push(pointAt(scenario, books, month, contributed, withBands));
  }
  return { points, shortfalls };
};

/** Month by month, per holding and in total: expected path and a 10–90 % band. */
export const forecast = (scenario: ForecastScenario): ForecastResult => ({
  ...simulate(scenario, true),
  real: scenario.real ?? true,
  inflation: scenario.inflation ?? DEFAULT_INFLATION,
});

/** First month index whose total on `path` reaches the target, or null within 600 months. */
export const monthsToReach = (
  scenario: ForecastScenario,
  targetEur: number,
  path: ForecastPath = "expected",
): number | null => {
  const { points } = simulate({ ...scenario, months: MAX_FORECAST_MONTHS }, path !== "expected");
  return points.find((point) => point.total[path] >= targetEur)?.index ?? null;
};

export type MonthlyNeeded = {
  readonly extraMonthlyEur: number;
  readonly rows: readonly { readonly holdingId: string; readonly extraMonthlyEur: number }[];
};

/** Spread whole cents by weight: floors first, the remainder to the last row, so rows sum exactly. */
const splitCents = (
  total: number,
  targets: readonly { readonly holdingId: string; readonly weight: number }[],
): MonthlyNeeded["rows"] => {
  const weightSum = targets.reduce((sum, row) => sum + row.weight, 0);
  const shares = targets.map((row) =>
    Math.floor(total * (weightSum > 0 ? row.weight / weightSum : 1 / targets.length) + 1e-9),
  );
  const rest = total - shares.slice(0, -1).reduce((sum, share) => sum + share, 0);
  return targets.map((row, index) => ({
    holdingId: row.holdingId,
    extraMonthlyEur: (index === targets.length - 1 ? rest : (shares[index] ?? 0)) / 100,
  }));
};

/** Extra monthly euros (to the cent) for the expected total to reach the target by `byMonth`; null when out of reach. */
export const monthlyNeeded = (
  scenario: ForecastScenario,
  targetEur: number,
  byMonth: number,
): MonthlyNeeded | null => {
  const existing = scenario.contributions ?? [];
  const targets =
    existing.length > 0
      ? existing.map((row) => ({ holdingId: row.holdingId, weight: row.monthlyEur }))
      : scenario.holdings.map((holding) => ({ holdingId: holding.id, weight: holding.valueEur }));
  if (targets.length === 0) return null;
  const rowsFor = (total: number) => splitCents(total, targets);
  const reached = (total: number): boolean => {
    const extra = rowsFor(total).map((row) => ({
      holdingId: row.holdingId,
      monthlyEur: row.extraMonthlyEur,
      toMonth: byMonth,
    }));
    const run = simulate(
      { ...scenario, months: byMonth, contributions: [...existing, ...extra] },
      false,
    );
    return (run.points[byMonth]?.total.expected ?? 0) >= targetEur;
  };
  const answer = (total: number): MonthlyNeeded => ({
    extraMonthlyEur: total / 100,
    rows: rowsFor(total),
  });
  if (reached(0)) return answer(0);
  let high = 100;
  while (!reached(high)) {
    if (high > MAX_MONTHLY_CENTS) return null;
    high *= 2;
  }
  let low = high === 100 ? 0 : high / 2;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (reached(middle)) high = middle;
    else low = middle;
  }
  return answer(high);
};

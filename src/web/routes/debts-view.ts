export const KIND_LABELS = { student_loan: "Student loan", credit_card: "Credit card" } as const;

const DAY_MS = 86_400_000;

const dayBefore = (iso: string): string =>
  new Date(Date.parse(`${iso}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);

/** A step line, oldest first: each balance holds until the day before the next, and the last holds to `today`. */
export const stepPoints = (
  balances: readonly { asOf: string; owedEur: string }[],
  today: string,
): { date: string; value: number }[] => {
  const sorted = balances
    .toSorted((a, b) => (a.asOf < b.asOf ? -1 : a.asOf > b.asOf ? 1 : 0))
    .map((balance) => ({ date: balance.asOf, value: Number(balance.owedEur) }));
  const points = sorted.flatMap((point, index) => {
    const previous = sorted[index - 1];
    if (previous === undefined) return [point];
    const hold = dayBefore(point.date);
    return hold > previous.date ? [{ date: hold, value: previous.value }, point] : [point];
  });
  const last = points.at(-1);
  if (last === undefined || last.date >= today) return points;
  return [...points, { date: today, value: last.value }];
};

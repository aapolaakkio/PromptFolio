export const KIND_LABELS = { student_loan: "Student loan", credit_card: "Credit card" } as const;

/** Oldest first, then a last point on `today` so the line reaches it. */
export const stepPoints = (
  balances: readonly { asOf: string; owedEur: string }[],
  today: string,
): { date: string; value: number }[] => {
  const points = balances
    .toSorted((a, b) => (a.asOf < b.asOf ? -1 : a.asOf > b.asOf ? 1 : 0))
    .map((balance) => ({ date: balance.asOf, value: Number(balance.owedEur) }));
  const last = points.at(-1);
  if (last === undefined || last.date >= today) return points;
  return [...points, { date: today, value: last.value }];
};

/**
 * Runs the first item alone, then the rest together. A new layout's first
 * file writes and stores the recipe; the others, previewed after it, reuse it
 * instead of each asking the model.
 */
export const firstThenRest = async <T, R>(
  items: readonly T[],
  run: (item: T) => Promise<R>,
): Promise<R[]> => {
  const [first, ...rest] = items;
  if (first === undefined) return [];
  const head = await run(first);
  return [head, ...(await Promise.all(rest.map(run)))];
};

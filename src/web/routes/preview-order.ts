/** Runs the first item alone, then the rest together: the first file of a new layout stores the recipe the others reuse. */
export const firstThenRest = async <T, R>(
  items: readonly T[],
  run: (item: T) => Promise<R>,
): Promise<R[]> => {
  const [first, ...rest] = items;
  if (first === undefined) return [];
  const head = await run(first);
  return [head, ...(await Promise.all(rest.map(run)))];
};

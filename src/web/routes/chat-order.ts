type Row = {
  readonly role: "user" | "assistant" | "proposal" | "note" | "chart";
  readonly content: string;
};

export type RenderItem<T extends Row> =
  | { readonly kind: "user"; readonly key: string; readonly content: string }
  | { readonly kind: "text"; readonly key: string; readonly content: string }
  | { readonly kind: "card"; readonly key: string; readonly turn: T };

type Indexed<T> = { readonly row: T; readonly at: number };

/** Rows from one question to the next; rows before any question form their own group. */
const groups = <T extends Row>(rows: readonly T[]): Indexed<T>[][] =>
  rows.reduce<Indexed<T>[][]>(
    (all, row, at) =>
      row.role === "user" || all.length === 0
        ? [...all, [{ row, at }]]
        : [...all.slice(0, -1), [...(all.at(-1) ?? []), { row, at }]],
    [],
  );

/** Within each exchange: the question, then all of the answer's text as one block, then its cards in arrival order, so streamed text never moves a card. */
export const renderItems = <T extends Row>(rows: readonly T[]): RenderItem<T>[] =>
  groups(rows).flatMap((group, index): RenderItem<T>[] => {
    const questions = group
      .filter(({ row }) => row.role === "user")
      .map(({ row }): RenderItem<T> => ({
        kind: "user",
        key: `user-${index}`,
        content: row.content,
      }));
    const text = group
      .filter(({ row }) => row.role === "assistant")
      .map(({ row }) => row.content)
      .join("\n\n");
    const cards = group
      .filter(({ row }) => row.role !== "user" && row.role !== "assistant")
      .map(({ row, at }): RenderItem<T> => ({ kind: "card", key: `card-${at}`, turn: row }));
    const answer: RenderItem<T>[] =
      text === "" ? [] : [{ kind: "text", key: `text-${index}`, content: text }];
    return [...questions, ...answer, ...cards];
  });

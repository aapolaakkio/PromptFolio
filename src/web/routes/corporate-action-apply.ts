import type { DraftResponse, EditableTxn } from "./imports-draft.ts";

type Proposal = NonNullable<DraftResponse["corporateActions"]>[number];

/** The action's rows as suggestions: booked legs are filled (or added when the preview skipped them), only the legs it names as skipped are removed. A missing cost basis stays blank for the owner. */
export const applyProposal = (
  rows: readonly EditableTxn[],
  proposal: Proposal,
  noteOf: (line: number) => string,
): EditableTxn[] => {
  const booked = new Map(proposal.rows.map((row) => [row.line, row] as const));
  const filled = (row: Proposal["rows"][number], note: string): EditableTxn => ({
    line: row.line,
    tradeDate: row.tradeDate,
    type: row.type,
    isin: row.isin,
    quantityText: row.quantityText,
    amountEur: row.amountEur ?? "",
    feeEur: row.feeEur,
    currency: row.currency,
    note,
    suggested: true,
  });
  const kept = rows.flatMap((row) => {
    const proposed = booked.get(row.line);
    if (proposed !== undefined) return [filled(proposed, row.note)];
    return proposal.skipped.includes(row.line) ? [] : [row];
  });
  const present = new Set(rows.map((row) => row.line));
  const added = proposal.rows
    .filter((row) => !present.has(row.line))
    .map((row) => filled(row, noteOf(row.line)));
  return [...kept, ...added];
};

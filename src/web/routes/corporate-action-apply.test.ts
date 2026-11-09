import { expect, test } from "vitest";

import { applyProposal } from "./corporate-action-apply.ts";
import type { DraftResponse, EditableTxn } from "./imports-draft.ts";

type Proposal = NonNullable<DraftResponse["corporateActions"]>[number];

const blankRow = (line: number, note: string): EditableTxn => ({
  line,
  tradeDate: "",
  type: "BUY",
  isin: "",
  quantityText: "",
  amountEur: "",
  feeEur: "0",
  currency: "EUR",
  note,
});

const bought: EditableTxn = {
  ...blankRow(2, "OSTO"),
  tradeDate: "2024-01-02",
  amountEur: "-400.00",
};

const split: Proposal = {
  lines: [3, 4],
  kind: "split",
  terms: "1:10",
  effectiveDate: "2024-06-10",
  sourceUrl: "https://www.nokia.com/investors/split",
  taxNote: "A split is not a disposal.",
  costBasisNeeded: [],
  rows: [
    {
      line: 4,
      type: "SPLIT",
      tradeDate: "2024-06-10",
      isin: "FI0009000681",
      quantityText: "1000",
      amountEur: "0",
      feeEur: "0",
      currency: "EUR",
    },
  ],
};

test("applying a split fills its row as a suggestion and drops the leg it does not book", () => {
  const rows = [bought, blankRow(3, "SPLIT OTTO"), blankRow(4, "SPLIT JÄTTÖ")];
  expect(applyProposal(rows, split, () => "")).toEqual([
    bought,
    {
      line: 4,
      tradeDate: "2024-06-10",
      type: "SPLIT",
      isin: "FI0009000681",
      quantityText: "1000",
      amountEur: "0",
      feeEur: "0",
      currency: "EUR",
      note: "SPLIT JÄTTÖ",
      suggested: true,
    },
  ]);
  expect(rows).toHaveLength(3);
});

test("a row the preview skipped is added with its own note; a missing cost basis stays blank", () => {
  const swapIn = { ...split.rows[0]!, type: "TRANSFER_IN", amountEur: null };
  const applied = applyProposal(
    [bought],
    { ...split, rows: [swapIn] },
    (line) => `skipped ${line}`,
  );
  expect(applied[1]).toMatchObject({ line: 4, amountEur: "", note: "skipped 4", suggested: true });
});

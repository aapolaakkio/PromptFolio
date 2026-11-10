import type { DraftResponse } from "./imports-draft.ts";

type Proposal = NonNullable<DraftResponse["corporateActions"]>[number];

const rowList = (lines: readonly number[]): string =>
  `${lines.length === 1 ? "row" : "rows"} ${lines.join(", ")}`;

/** A model's reading of one corporate action, checked by the server against the broker's rows. Nothing is booked until the owner applies it and commits the import. */
export const CorporateActionCard = ({
  proposal,
  onApply,
  onIgnore,
}: {
  readonly proposal: Proposal;
  readonly onApply: () => void;
  readonly onIgnore: () => void;
}) => {
  return (
    <section className="mt-3 rounded border border-accent p-3 text-sm">
      <p>
        <span className="rounded-full border border-accent px-2 py-0.5 text-xs text-accent">
          AI suggestion — check
        </span>{" "}
        Corporate action on {rowList(proposal.lines)}: <strong>{proposal.kind}</strong>,{" "}
        {proposal.terms}, effective {proposal.effectiveDate}.
      </p>
      <p className="mt-1">Tax assumption: {proposal.taxNote}</p>
      <p className="mt-1">
        Source:{" "}
        <a href={proposal.sourceUrl} target="_blank" rel="noreferrer noopener">
          {proposal.sourceUrl}
        </a>
      </p>
      <p className="mt-1 text-muted">
        Books {proposal.rows.map((row) => `row ${row.line} as ${row.type}`).join(", ")}
        {proposal.skipped.length > 0 && `; ${rowList(proposal.skipped)} not booked`}.
      </p>
      {proposal.costBasisNeeded.length > 0 && (
        <p className="mt-1 text-loss">
          Cost basis needed on {rowList(proposal.costBasisNeeded)}: enter the acquisition value as
          the amount, or 0 to carry over the lots of the shares given up. It is not guessed.
        </p>
      )}
      <div className="mt-2 flex gap-2">
        <button type="button" className="primary-button" onClick={onApply}>
          Apply to these rows
        </button>
        <button type="button" onClick={onIgnore}>
          Ignore
        </button>
      </div>
    </section>
  );
};

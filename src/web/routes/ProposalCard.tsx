import type { CardOutcome } from "./proposal-actions.ts";

const OUTCOME_LINE = {
  saved: "Saved.",
  failed: "Not saved.",
  dismissed: "Dismissed. Nothing was saved.",
} as const;

/** The app's own description of one proposed change; only the owner's click runs it. */
export const ProposalCard = ({
  summary,
  state,
  outcome,
  saving,
  onConfirm,
  onDismiss,
}: {
  readonly summary: string;
  readonly state: "open" | "decided" | "expired";
  readonly outcome: CardOutcome | undefined;
  readonly saving: boolean;
  readonly onConfirm: () => void;
  readonly onDismiss: () => void;
}) => (
  <div className="card max-w-[90%] grid gap-2 text-sm">
    <p className="text-xs text-muted">Proposed change</p>
    <p>{summary}</p>
    {state === "open" && (
      <div className="flex gap-2">
        <button type="button" disabled={saving} onClick={onConfirm}>
          {saving ? "Saving…" : "Confirm"}
        </button>
        <button type="button" className="quiet-button" disabled={saving} onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    )}
    {state === "decided" && outcome !== undefined && (
      <p role="status" className={outcome.outcome === "failed" ? "text-loss" : "text-accent"}>
        {OUTCOME_LINE[outcome.outcome]}
        {outcome.detail === undefined ? "" : ` ${outcome.detail}`}
      </p>
    )}
    {state === "expired" && (
      <p className="text-muted">Expired. Ask again, or make the change on its own page.</p>
    )}
  </div>
);

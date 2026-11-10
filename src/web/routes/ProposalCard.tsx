import {
  confirmLabel,
  removalOf,
  type Fact,
  type ProposalAction,
} from "../../server/chat/proposal-schema.ts";
import { money } from "../lib/format.ts";
import type { CardOutcome } from "./proposal-actions.ts";

const OUTCOME_LINE = {
  saved: "Saved.",
  failed: "Not saved.",
  dismissed: "Dismissed. Nothing was saved.",
} as const;

const FactValue = ({ fact }: { readonly fact: Fact }) => {
  switch (fact.kind) {
    case "text":
      return <>{fact.text}</>;
    case "money":
      return <>{money(fact.amount, fact.currency)}</>;
    case "code":
      return <code>{fact.code}</code>;
  }
};

/** The app's own description of one proposed change, as label and value; only the owner's click runs it. */
export const ProposalCard = ({
  action,
  title,
  facts,
  note,
  state,
  outcome,
  saving,
  onConfirm,
  onDismiss,
}: {
  /** Decides the look: a removal is warning-styled whatever the stored card says. */
  readonly action: ProposalAction;
  readonly title: string;
  readonly facts: readonly Fact[];
  /** The assistant's own words, kept out of the facts so they cannot read as the app's. */
  readonly note: string | undefined;
  readonly state: "open" | "decided" | "expired";
  readonly outcome: CardOutcome | undefined;
  readonly saving: boolean;
  readonly onConfirm: () => void;
  readonly onDismiss: () => void;
}) => {
  const removal = removalOf(action);
  const danger = removal !== null;
  return (
    <div
      className={`bg-surface border rounded-(--radius-card) p-5 max-w-[90%] grid gap-2 text-sm ${danger ? "border-loss" : "border-line"}`}
    >
      {danger ? (
        <p className="text-loss font-semibold">⚠ Delete</p>
      ) : (
        <p className="text-xs text-muted">Proposed change</p>
      )}
      <p className="font-semibold">{title}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        {facts.map((fact, index) => (
          <div key={`${fact.label}-${index}`} className="contents">
            <dt>{fact.label}</dt>
            <dd>
              <FactValue fact={fact} />
            </dd>
          </div>
        ))}
      </dl>
      {note !== undefined && note !== "" && (
        <div className="border-t border-line pt-2">
          <p className="text-xs text-muted">Note (written by the assistant)</p>
          <p className="whitespace-pre-wrap">{note}</p>
        </div>
      )}
      {danger && <p className="text-loss">This removes data. {removal?.after}</p>}
      {state === "open" && (
        <div className="flex gap-2">
          <button
            type="button"
            className={danger ? "danger-button" : "primary-button"}
            disabled={saving}
            onClick={onConfirm}
          >
            {saving ? "Saving…" : confirmLabel(action)}
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
};

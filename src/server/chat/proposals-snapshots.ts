import { and, eq } from "drizzle-orm";

import { EUR, formatQuantity, parseQuantity } from "../../core/money.ts";
import { AdjustInput, CreateSnapshot } from "../action-inputs.ts";
import { transactions } from "../db/schema.ts";
import { listInstruments } from "../instruments/store.ts";
import { holdingsTotalCheck } from "../snapshot/holdings-draft.ts";
import { adjustmentRow } from "../snapshot/service.ts";
import {
  ASK_WHEN_UNSURE,
  AWAITS,
  accountName,
  canonical,
  instrumentLabel,
  money,
  newId,
  ownAccount,
  ownSnapshot,
  quantityText,
  text,
} from "./proposal-kit.ts";
import type { Fact, Proposal } from "./proposal-schema.ts";
import type { Db, ProposalArea, ProposalTool, ToolArgs } from "./tool-types.ts";

const STATEMENTS: ProposalArea = {
  name: "Holdings statements",
  sentence:
    "record a holdings statement typed by hand and book a reconcile adjustment for one row of a statement",
};

const EUROS = /^\d+([.,]\d{1,2})?$/;

/** Up to three facts per row must fit the card's fact limit. */
const MAX_CARD_ROWS = 60;

/** A quantity as the card shows it; refused rather than guessed. */
const units = (quantity: string): string => {
  let parsed;
  try {
    parsed = parseQuantity(quantity.replace(",", "."));
  } catch {
    throw new Error(`The quantity ${quantity} is not a valid decimal number`);
  }
  if (parsed.scaled <= 0n) throw new Error("A quantity must be above 0");
  return quantityText(parsed);
};

/** The registry is household-shared and a statement may list what the ledger lacks (that is the difference it shows); names come from the registry. */
const proposeSnapshot = async (db: Db, userId: string, raw: ToolArgs): Promise<Proposal> => {
  const input = CreateSnapshot.parse(raw);
  if (input.rows.length > MAX_CARD_ROWS) {
    throw new Error(
      `A card holds at most ${MAX_CARD_ROWS} rows; a longer statement goes in on the account's statements page`,
    );
  }
  if (input.source !== "manual")
    throw new Error("A statement from chat is typed by hand: source manual");
  const account = await ownAccount(db, userId, input.accountId);
  const registry = new Map((await listInstruments(db)).map((item) => [item.id, item]));
  if (new Set(input.rows.map((row) => row.instrumentId)).size !== input.rows.length) {
    throw new Error("An instrument appears twice in the statement");
  }
  const rows = input.rows.flatMap((row): Fact[] => {
    const instrument = registry.get(row.instrumentId);
    if (instrument === undefined) {
      throw new Error(
        `Instrument not found: ${row.instrumentId}. Ask the owner which one is meant`,
      );
    }
    return [
      text(instrumentLabel(instrument), `${units(row.quantity)} units`),
      ...(row.nav === undefined ? [] : [money("NAV", canonical(row.nav, EUR), EUR)]),
      ...(row.marketValue === undefined
        ? []
        : [money("Market value", canonical(row.marketValue, EUR), EUR)]),
    ];
  });
  const stated = input.statedTotalEur ?? null;
  const check = holdingsTotalCheck(
    input.rows.map((row) => ({ marketValueEur: row.marketValue ?? "0" })),
    stated === null ? null : canonical(stated, EUR),
  );
  if (check !== null && !check.ok) {
    throw new Error(
      `Row values do not match the statement total (difference ${check.differenceEur} €)`,
    );
  }
  return {
    proposalId: newId(),
    action: "snapshot",
    title: "Record a holdings statement",
    facts: [
      text("Account", accountName(account)),
      text("Statement date", input.asOf),
      text("Source", "Typed by hand"),
      ...rows,
      ...(stated === null ? [] : [money("Statement total", canonical(stated, EUR), EUR)]),
    ],
    summary:
      `Record a holdings statement typed by hand for ${accountName(account)} as of ${input.asOf}, ` +
      `with ${input.rows.length} row${input.rows.length === 1 ? "" : "s"}.`,
    input,
  };
};

const proposeAdjust = async (db: Db, userId: string, raw: ToolArgs): Promise<Proposal> => {
  const input = AdjustInput.parse(raw);
  if (input.costEur !== undefined && !EUROS.test(input.costEur)) {
    throw new Error("Cost basis in euros with at most two decimals, for example 1234.56");
  }
  await ownSnapshot(db, userId, input.snapshotId);
  const { snapshot, row } = await adjustmentRow(userId, input.snapshotId, input.instrumentId);
  if (row.withinTolerance) throw new Error("The row already matches; nothing to correct");
  const corrected = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(
      and(
        eq(transactions.accountId, snapshot.accountId),
        eq(transactions.externalId, `adjustment:${snapshot.id}:${input.instrumentId}`),
      ),
    )
    .get();
  if (corrected !== undefined) throw new Error("This row has already been corrected");
  const arriving = row.delta.scaled > 0n;
  if (arriving && input.costEur === undefined) {
    throw new Error("Cost basis is required when units are added: ask the owner what they paid");
  }
  if (!arriving && input.costEur !== undefined) {
    throw new Error("Cost basis must not be given when units are removed");
  }
  const account = await ownAccount(db, userId, snapshot.accountId);
  const instrument = (await listInstruments(db)).find((item) => item.id === input.instrumentId);
  const name =
    instrument === undefined ? `Instrument ${input.instrumentId}` : instrumentLabel(instrument);
  const quantity = quantityText({ scaled: arriving ? row.delta.scaled : -row.delta.scaled });
  const cost = input.costEur === undefined ? null : canonical(input.costEur, EUR);
  const statement = `${accountName(account)}, statement of ${snapshot.asOf} (#${snapshot.id})`;
  return {
    proposalId: newId(),
    action: "snapshot_adjust",
    title: "Book a reconcile adjustment",
    facts: [
      text("Statement", statement),
      text("Instrument", name),
      text("Direction", arriving ? "Units in (transfer in)" : "Units out (transfer out)"),
      text("Quantity", `${quantity} units`),
      text("Date", snapshot.asOf),
      cost === null ? text("Cost basis", "None: units leave") : money("Cost basis", cost, EUR),
    ],
    summary:
      `Book ${quantity} units of ${name} ${arriving ? "into" : "out of"} ${accountName(account)} ` +
      `on ${snapshot.asOf} to match the statement${cost === null ? "" : `, at a cost of ${cost} EUR`}.`,
    // The cost as the card shows it, so the save stores exactly that.
    input: {
      snapshotId: input.snapshotId,
      instrumentId: input.instrumentId,
      costEur: cost ?? undefined,
      expectQuantity: formatQuantity(row.delta),
    },
  };
};

export const buildSnapshotProposals = (db: Db, userId: string): ProposalTool[] => [
  {
    area: STATEMENTS,
    name: "propose_snapshot",
    description:
      "Proposes a holdings statement the owner typed or read to you: accountId from get_accounts, " +
      "asOf, source manual, rows of {instrumentId (get_instruments), quantity, optional nav and " +
      "marketValue in euros}, optional statedTotalEur that the rows must add up to. A file or a " +
      "pasted table goes to the Imports page instead." +
      ASK_WHEN_UNSURE +
      AWAITS,
    schema: CreateSnapshot,
    propose: (input) => proposeSnapshot(db, userId, input),
  },
  {
    area: STATEMENTS,
    name: "propose_snapshot_adjust",
    description:
      "Proposes booking the difference on one statement row so the ledger matches it: snapshotId " +
      "and instrumentId from get_snapshots. When units arrive, costEur (what the owner paid) is " +
      "required; ask for it, never guess. When units leave, give no costEur." +
      AWAITS,
    schema: AdjustInput,
    propose: (input) => proposeAdjust(db, userId, input),
  },
];

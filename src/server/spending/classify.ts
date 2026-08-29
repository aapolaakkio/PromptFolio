import { z } from "zod";

import type { Txn } from "../../core/types";
import type { getDb } from "../db";
import type { ToolRunnerClient } from "../chat/runner";
import { CATEGORY_LABELS } from "./categories";
import { addRules, categoriseWith, rulesFor, type SpendingRule } from "./rules";

type Db = ReturnType<typeof getDb>["db"];

/** How many unknown merchants one import may ask the model about. */
const BATCH_LIMIT = 40;

export type ClassifyResult = {
  readonly asked: number;
  readonly added: number;
  readonly rejected: number;
  /** Null when nothing needed classifying, or when the model could not be reached. */
  readonly error: string | null;
};

const ProposalsSchema = z.object({
  rules: z.array(z.object({ pattern: z.string(), category: z.string() })).max(BATCH_LIMIT),
});

/**
 * The merchants an import brought in that no rule covers.
 *
 * Names are shortened to the counterparty alone -- the label and message around
 * it are per payment, and asking about "PKORTTIMAKSU — K-MARKET — 12.3.2026"
 * would produce a rule that matches exactly one row.
 */
export const unknownMerchants = (
  txns: readonly Txn[],
  rules: readonly SpendingRule[],
  accountIds: ReadonlySet<number>,
): string[] => {
  const seen = new Set<string>();
  for (const txn of txns) {
    if (!accountIds.has(txn.accountId)) continue;
    if (txn.amount.minor >= 0n) continue;
    const note = txn.note ?? "";
    if (categoriseWith(note, rules) !== "muu") continue;
    const parts = note.split(" — ");
    const merchant = (parts.length > 1 ? parts[1] : parts[0])?.trim().toUpperCase() ?? "";
    if (merchant !== "") seen.add(merchant);
  }
  return [...seen].slice(0, BATCH_LIMIT);
};

const promptFor = (merchants: readonly string[]): string =>
  [
    "Luokittele nämä maksunsaajat suomalaisen pankkitiliotteen kuluiksi.",
    "",
    "Käytettävissä olevat luokat:",
    ...Object.entries(CATEGORY_LABELS).map(([id, label]) => `- ${id}: ${label}`),
    "",
    "Maksunsaajat:",
    ...merchants.map((name) => `- ${name}`),
    "",
    "Vastaa pelkkänä JSON-oliona muodossa",
    '{"rules":[{"pattern":"K-MARKET","category":"ruoka"}]}',
    "Säännöt:",
    "- pattern on ISOilla kirjaimilla ja sen on oltava osajono maksunsaajan nimestä.",
    "- Käytä lyhyintä nimeä joka tunnistaa ketjun (esim. 'K-MARKET', ei 'K-MARKET SALO 123').",
    "- Jätä pois maksunsaajat joita et tunnista. Väärä luokka on huonompi kuin ei luokkaa.",
    "- Älä keksi uusia luokkia; käytä vain yllä lueteltuja tunnisteita.",
  ].join("\n");

/** The first JSON object in a reply, since a model may wrap it in prose or a fence. */
const parseProposals = (text: string): { pattern: string; category: string }[] => {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return [];
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    return ProposalsSchema.parse(parsed).rules;
  } catch {
    return [];
  }
};

/**
 * Asks the model to classify the merchants an import did not recognise, and
 * stores what it proposes as rules.
 *
 * One batched call per import rather than one per merchant, and capped: a year
 * of card payments can name several hundred shops, and the point is to teach the
 * rules the common ones, not to spend a euro on the tail.
 *
 * Every proposal is checked before it is stored -- the category must be one that
 * exists, and the pattern must actually occur in a merchant name the import
 * brought in. A model asked for JSON will occasionally invent a category or a
 * shop, and a wrong rule quietly mis-files spending from then on. Failure is
 * reported, never thrown: an import that succeeded must not be undone because
 * the classifier could not be reached.
 */
export const classifyNewMerchants = async (
  db: Db,
  userId: string,
  args: {
    txns: readonly Txn[];
    accountIds: ReadonlySet<number>;
    client: ToolRunnerClient;
    model: string;
  },
): Promise<ClassifyResult> => {
  const rules = rulesFor(db, userId);
  const merchants = unknownMerchants(args.txns, rules, args.accountIds);
  if (merchants.length === 0) return { asked: 0, added: 0, rejected: 0, error: null };

  try {
    const runner = args.client.beta.messages.toolRunner({
      model: args.model,
      max_tokens: 2048,
      system: "Olet luokittelija. Vastaat pelkällä JSONilla, ilman selityksiä tai koodilohkoja.",
      messages: [{ role: "user", content: promptFor(merchants) }],
      tools: [],
      thinking: { type: "adaptive" },
    });

    let reply = "";
    for await (const message of runner) {
      for (const block of message.content) {
        if (block.type === "text") reply += block.text;
      }
    }

    const upper = merchants.map((name) => name.toUpperCase());
    const proposals = parseProposals(reply).filter((proposal) =>
      upper.some((name) => name.includes(proposal.pattern.trim().toUpperCase())),
    );
    const { added, rejected } = addRules(db, userId, proposals, "ai");
    return {
      asked: merchants.length,
      added: added.length,
      rejected: rejected.length,
      error: null,
    };
  } catch (cause) {
    return {
      asked: merchants.length,
      added: 0,
      rejected: 0,
      error: cause instanceof Error ? cause.message : "Luokittelu epäonnistui",
    };
  }
};

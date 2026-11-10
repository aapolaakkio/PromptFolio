import { z } from "zod";

import type { Txn } from "../../core/types.ts";
import type { Db } from "../db/index.ts";
import { maskAccountNumbers } from "../chat/mask.ts";
import type { ChatClient } from "../chat/runner.ts";
import { CATEGORY_LABELS } from "./categories.ts";
import { addRules, categoriseWith, rulesFor, type SpendingRule } from "./rules.ts";

const BATCH_LIMIT = 40;

export type ClassifyResult = {
  readonly asked: number;
  readonly added: number;
  readonly rejected: number;
  readonly error: string | null;
};

const ProposalsSchema = z.object({
  rules: z.array(z.object({ pattern: z.string(), category: z.string() })).max(BATCH_LIMIT),
});

/** Merchants no rule covers, shortened to the counterparty: a per-payment label would yield a rule matching one row. */
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
    if (categoriseWith(note, rules) !== "other") continue;
    const parts = note.split(" — ");
    const merchant = (parts.length > 1 ? parts[1] : parts[0])?.trim().toUpperCase() ?? "";
    if (merchant !== "") seen.add(merchant);
  }
  return [...seen].slice(0, BATCH_LIMIT);
};

const promptFor = (merchants: readonly string[]): string =>
  [
    "Classify these payees from a Finnish bank statement into spending categories.",
    "The app serves Finnish customers; their accounts and banks are Finnish, and Finnish law and practice apply.",
    "",
    "Available categories:",
    ...Object.entries(CATEGORY_LABELS).map(([id, label]) => `- ${id}: ${label}`),
    "",
    "Payees:",
    ...merchants.map((name) => `- ${maskAccountNumbers(name)}`),
    "",
    "Reply with a JSON object only, in the form",
    '{"rules":[{"pattern":"K-MARKET","category":"groceries"}]}',
    "Rules:",
    "- pattern is in UPPER CASE and must be a substring of the payee name.",
    "- Use the shortest name that identifies the chain (e.g. 'K-MARKET', not 'K-MARKET SALO 123').",
    "- Leave out payees you do not recognise. A wrong category is worse than none.",
    "- Do not invent categories; use only the ids listed above.",
  ].join("\n");

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
 * Asks the model to classify unrecognised merchants and stores its proposals as rules. One capped
 * batch per import (a year can name hundreds of shops). Each proposal is checked: the category must
 * exist and the pattern must occur in an imported merchant name, since a model invents both.
 * Failure is reported, never thrown: a succeeded import must not be undone by the classifier.
 */
export const classifyNewMerchants = async (
  db: Db,
  userId: string,
  args: {
    txns: readonly Txn[];
    accountIds: ReadonlySet<number>;
    client: ChatClient;
    model: string;
  },
): Promise<ClassifyResult> => {
  const rules = await rulesFor(db, userId);
  const merchants = unknownMerchants(args.txns, rules, args.accountIds);
  if (merchants.length === 0) return { asked: 0, added: 0, rejected: 0, error: null };

  try {
    const reply = await args.client.run({
      model: args.model,
      // Room for a rule per merchant: at 2048 a full batch was cut off mid-object and silently reported "no new rules".
      max_tokens: 8192,
      messages: [
        {
          role: "system",
          content:
            "You are a classifier for a Finnish personal-finance app whose customers, banks and brokers are Finnish. Reply in English with JSON only, no explanations or code fences.",
        },
        { role: "user", content: promptFor(merchants) },
      ],
      tools: [],
    });

    const parsed = parseProposals(reply.text);
    const upper = merchants.map((name) => name.toUpperCase());
    const proposals = parsed.filter((proposal) =>
      upper.some((name) => name.includes(proposal.pattern.trim().toUpperCase())),
    );
    const { added, rejected } = await addRules(db, userId, proposals, "ai");
    return {
      asked: merchants.length,
      added: added.length,
      rejected: rejected.length,
      // An unparsed reply is reported as a failure; from outside it looks like an import with no new merchants.
      error: parsed.length === 0 ? "The model returned no rules (reply did not parse)" : null,
    };
  } catch (cause) {
    return {
      asked: merchants.length,
      added: 0,
      rejected: 0,
      error: cause instanceof Error ? cause.message : "Classification failed",
    };
  }
};

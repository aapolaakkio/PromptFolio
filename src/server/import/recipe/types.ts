import { z } from "zod";

import { mayBacktrackForever } from "./pattern-safety.ts";

/** Length does not bound cost; the cap stops expensive compiles. */
export const MAX_PATTERN_LENGTH = 1_000;

export const Pattern = z
  .string()
  .min(1)
  .max(MAX_PATTERN_LENGTH)
  .refine(
    (source) => {
      try {
        new RegExp(source, "u");
        return true;
      } catch {
        return false;
      }
    },
    { message: "The regular expression could not be compiled" },
  )
  // Run time cannot be bounded once `exec` is entered, so shapes that blow up are refused
  // here. Heuristic: it clears `(a+)+` and relatives; the run loop keeps its time budget too.
  .refine((source) => !mayBacktrackForever(source), {
    message: "The regular expression may hang (nested repetition)",
  });

export const MoneyFormatSchema = z
  .object({
    decimal: z.enum([",", "."]),
    thousands: z.enum([" ", " ", ".", ",", "'", ""]),
    negative: z.enum(["leading", "trailing", "parentheses", "suffix"]),
    debitWords: z.array(z.string().min(1)).max(10).optional(),
    strip: z.array(z.string().min(1)).max(10).optional(),
    twoColumn: z.boolean(),
  })
  .strict()
  .superRefine((money, ctx) => {
    if (money.thousands !== "" && money.thousands === money.decimal) {
      ctx.addIssue({
        code: "custom",
        message: "The thousands separator and the decimal separator cannot be the same character",
      });
    }
  });
export type MoneyFormat = z.infer<typeof MoneyFormatSchema>;

const HeaderSchema = z
  .object({
    from: Pattern.optional(),
    to: Pattern.optional(),
    openingBalance: Pattern.optional(),
    closingBalance: Pattern.optional(),
    maturityDate: Pattern.optional(),
  })
  .strict();

const BaseRecipe = z
  .object({
    kind: z.literal("bank"),
    skip: z.array(Pattern).max(40),
    recordStart: Pattern,
    continuation: z.array(Pattern).max(20),
    restField: z.enum(["counterparty", "message"]).nullable(),
    header: HeaderSchema,
    dateFormat: z.enum(["d.m.yyyy", "dd.mm.yyyy", "m.d.yyyy", "yyyy-mm-dd", "d.m."]),
    money: MoneyFormatSchema,
  })
  .strict();

export const groupNames = (source: string): string[] =>
  [...source.matchAll(/\(\?<([A-Za-z][A-Za-z0-9]*)>/g)].map((m) => m[1] ?? "");

/** Where fields are named is deliberately unchecked: every such rule refused some real layout. */
export const BankRecipeSchema = BaseRecipe.superRefine((recipe, ctx) => {
  const named = new Set([
    ...groupNames(recipe.recordStart),
    ...recipe.continuation.flatMap(groupNames),
  ]);
  if (!named.has("date")) {
    ctx.addIssue({
      code: "custom",
      message: "The date group is not named in recordStart or continuation",
    });
  }
  const hasPair = named.has("debit") && named.has("credit");
  if (!named.has("amount") && !hasPair) {
    ctx.addIssue({
      code: "custom",
      message:
        "Neither the amount group nor the debit/credit groups are named in recordStart or continuation",
    });
  }
});

export type BankRecipe = z.infer<typeof BaseRecipe>;

const INVALID = "The model's description of the file format is not valid";

// eslint-disable-next-line anti-slop/no-unknown-parameters
export const parseRecipe = (raw: unknown): BankRecipe => {
  const parsed = BankRecipeSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${INVALID}: ${parsed.error.message}`);
  return parsed.data;
};

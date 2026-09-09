import { z } from "zod";

import { mayBacktrackForever } from "./pattern-safety.ts";

/**
 * A model writes these patterns, so they are capped and compiled before use.
 *
 * Length is not what bounds a pattern's cost -- `mayBacktrackForever` and the
 * run's time budget are -- so the cap only has to stop a pattern that is
 * expensive to compile at all. It has room for the shape the instructions
 * teach: one alternation of every page-furniture word a statement prints. The
 * OP recipe the model is shown as an example already spends 202 characters on
 * its own, and a statement whose furniture is wordier was refused outright
 * under a 400-character cap.
 */
export const MAX_PATTERN_LENGTH = 1_000;

/** A pattern the model wrote: length-capped and known to compile. */
const Pattern = z
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
    { message: "Säännöllistä lauseketta ei voitu kääntää" },
  )
  // A pattern's own run time cannot be bounded once `exec` has been entered,
  // so the shapes that blow up are refused here instead. Heuristic, not a
  // decision procedure: it clears `(a+)+` and its relatives, and a pattern it
  // accepts can still be slow -- the run loop keeps its time budget as well.
  .refine((source) => !mayBacktrackForever(source), {
    message: "Säännöllinen lauseke voi jäädä jumiin (sisäkkäinen toisto)",
  });

const MoneyFormatSchema = z
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
        message: "Tuhaterotin ja desimaalierotin eivät voi olla sama merkki",
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
    /**
     * Which part comes first. `readDate` reads the separator, the year's width
     * and a spelled-out month as they come, so each name covers a family of
     * shapes rather than one exact punctuation.
     */
    dateFormat: z.enum(["d.m.yyyy", "dd.mm.yyyy", "m.d.yyyy", "yyyy-mm-dd", "d.m."]),
    money: MoneyFormatSchema,
  })
  .strict();

const groupNames = (source: string): ReadonlySet<string> =>
  new Set([...source.matchAll(/\(\?<([A-Za-z][A-Za-z0-9]*)>/g)].map((m) => m[1] ?? ""));

/**
 * A record is only a transaction if it says when and how much. Checked here
 * rather than at run time so a recipe that could never produce a row is refused
 * before it is stored, not after it has silently read a statement as empty.
 *
 * WHERE either is named is not this schema's business. A statement prints its
 * date, its amount and its payee on whichever lines its bank chose, and every
 * rule about which line carries which field refused some real layout outright
 * -- leaving no description a model could write, whatever it understood about
 * the file. A record start still has to exist, because rows are what repeats;
 * the fields inside one are read from wherever they were named.
 */
export const BankRecipeSchema = BaseRecipe.superRefine((recipe, ctx) => {
  const named = new Set([
    ...groupNames(recipe.recordStart),
    ...recipe.continuation.flatMap((pattern) => [...groupNames(pattern)]),
  ]);
  if (!named.has("date")) {
    ctx.addIssue({
      code: "custom",
      message: "date-ryhmää ei nimetä recordStartissa eikä continuationissa",
    });
  }
  const hasPair = named.has("debit") && named.has("credit");
  if (!named.has("amount") && !hasPair) {
    ctx.addIssue({
      code: "custom",
      message: "amount- eikä debit/credit-ryhmää ei nimetä recordStartissa eikä continuationissa",
    });
  }
});

export type BankRecipe = z.infer<typeof BaseRecipe>;

const INVALID = "Mallin kuvaus tiedostomuodosta ei kelpaa";

// eslint-disable-next-line anti-slop/no-unknown-parameters
export const parseRecipe = (raw: unknown): BankRecipe => {
  const parsed = BankRecipeSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${INVALID}: ${parsed.error.message}`);
  return parsed.data;
};

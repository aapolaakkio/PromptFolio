import { z } from "zod";

/**
 * A model writes these patterns, so they are capped and compiled before use.
 * Long enough for a real record-start line, short enough that no single pattern
 * can be a denial of service on its own.
 */
export const MAX_PATTERN_LENGTH = 400;

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
  );

const MoneyFormatSchema = z
  .object({
    decimal: z.enum([",", "."]),
    thousands: z.enum([" ", " ", ".", ",", "'", ""]),
    negative: z.enum(["leading", "trailing", "parentheses", "suffix"]),
    debitWords: z.array(z.string().min(1)).max(10).optional(),
    strip: z.array(z.string().min(1)).max(10).optional(),
    twoColumn: z.boolean(),
  })
  .strict();
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
    dateFormat: z.enum(["d.m.yyyy", "dd.mm.yyyy", "yyyy-mm-dd", "d.m."]),
    money: MoneyFormatSchema,
  })
  .strict();

const groupNames = (source: string): ReadonlySet<string> =>
  new Set([...source.matchAll(/\(\?<([A-Za-z][A-Za-z0-9]*)>/g)].map((m) => m[1] ?? ""));

/**
 * A record is only a transaction if it says when and how much. Checked here
 * rather than at run time so a recipe that could never produce a row is refused
 * before it is stored, not after it has silently read a statement as empty.
 */
export const BankRecipeSchema = BaseRecipe.superRefine((recipe, ctx) => {
  const groups = groupNames(recipe.recordStart);
  if (!groups.has("date")) {
    ctx.addIssue({ code: "custom", message: "recordStart ei nimeä ryhmää date" });
  }
  const hasPair = groups.has("debit") && groups.has("credit");
  if (!groups.has("amount") && !hasPair) {
    ctx.addIssue({
      code: "custom",
      message: "recordStart ei nimeä ryhmää amount eikä debit/credit",
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

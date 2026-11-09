import { z } from "zod";

import { EUR, parseMoney } from "../core/money.ts";
import { BASIS_POINTS } from "../core/rebalance/targets.ts";
import { isRealCalendarDate } from "./calendar-date.ts";
import { currencyField } from "./currency-field.ts";

// One schema per owner action, shared by its server function, the chat proposal tool and the browser card: no server-only imports here.

const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in the format YYYY-MM-DD");

/** The price-form schema; the calendar check sits on the shape since 2024-02-31 matches the pattern. */
export const PriceInput = z.object({
  instrumentId: z.number().int().positive(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "The date must be in the format YYYY-MM-DD")
    .refine(isRealCalendarDate, "The date is not a real calendar date"),
  // A decimal string, never a JSON number; parsed by core/money, never Number().
  price: z.string().min(1, "Price is missing").max(30, "Price is too long"),
});

/** The only cash movements a person may write by hand. Trades are absent: they carry an instrument and cost basis no broker record would back. Opening balance is included, else balances derived from a statement are short. */
export const CashEntry = z
  .object({
    accountId: z.number().int().positive(),
    type: z.enum(["OPENING_BALANCE", "DEPOSIT", "WITHDRAWAL", "INTEREST"]),
    tradeDate: IsoDateSchema,
    /** A decimal string, never a JSON number. */
    amount: z.string().regex(/^\d+([.,]\d{1,2})?$/, "Amount in the format 1234.56"),
    currency: currencyField.default(EUR),
    note: z.string().trim().max(200).optional(),
  })
  .strict();

export const DimensionInput = z.enum(["kind", "currency", "account", "instrument"]);

/** A target set on one dimension; percentages are decimal strings, more than two decimals refused. */
export const TargetAllocationInput = z.object({
  dimension: DimensionInput,
  targets: z
    .array(
      z
        .object({
          key: z.string().min(1).max(120),
          weightPercent: z.string().regex(/^\d+([.,]\d{1,2})?$/, "Share in the format 12.34"),
        })
        .strict(),
    )
    .min(1)
    .max(200),
});

/** A percentage as a decimal string, converted to integer basis points; more than two decimals is refused, not rounded. */
export const toBasisPoints = (percent: string): number =>
  Math.round(Number(percent.replace(",", ".")) * (BASIS_POINTS / 100));

const MAX_SOURCE_KEY = 200;
export const MAX_PAGE_URL = 2000;
export const tooLongKey = (priceSource: string, sourceKey: string | undefined): boolean =>
  (sourceKey ?? "").length > (priceSource === "page" ? MAX_PAGE_URL : MAX_SOURCE_KEY);
export const KEY_TOO_LONG = "Source code is too long";

/** An instrument's currency, price source and source code, as the edit form sends them. */
export const InstrumentEdit = z
  .object({
    id: z.number().int().positive(),
    currency: currencyField,
    priceSource: z.enum(["yahoo", "page", "manual"]),
    sourceKey: z.string().max(MAX_PAGE_URL),
  })
  .refine((body) => !tooLongKey(body.priceSource, body.sourceKey), {
    message: KEY_TOO_LONG,
    path: ["sourceKey"],
  });

const MAX_PLAN_MINOR = 100_000_000n;
const PLAN_AMOUNT = /^\d+([.,]\d{1,2})?$/;

/** One monthly plan row: an instrument and a sum in euros, above 0 and at most 1 000 000. */
export const PlanRowInput = z
  .object({
    instrumentId: z.number().int().positive(),
    // One refine, not a regex then a refine: zod runs both, and parseMoney throws on text the regex refused.
    amountEur: z
      .string()
      .refine((text) => PLAN_AMOUNT.test(text), "Amount in the format 1234.56")
      .refine((text) => {
        if (!PLAN_AMOUNT.test(text)) return true;
        const { minor } = parseMoney(text, EUR);
        return minor > 0n && minor <= MAX_PLAN_MINOR;
      }, "The amount must be above 0 and at most 1 000 000"),
  })
  .strict();

export const MAX_PLAN_ROWS = 30;

/** The whole plan in one go: `replace` makes it exactly these rows, `add` upserts them and keeps the rest. */
const noDuplicates = (rows: readonly { readonly instrumentId: number }[]): boolean =>
  new Set(rows.map((row) => row.instrumentId)).size === rows.length;

const planRows = z.array(PlanRowInput).min(1).max(MAX_PLAN_ROWS);

/** What the model proposes: `replace` makes the plan exactly these rows, `add` upserts them and keeps the rest. */
export const PlanInput = z
  .object({ rows: planRows, mode: z.enum(["replace", "add"]) })
  .strict()
  .refine((plan) => noDuplicates(plan.rows), {
    message: "An instrument appears twice in the plan",
    path: ["rows"],
  });

/** What Confirm saves: the app fills `removeInstrumentIds` and `fingerprint` when it builds the card, so a row added afterwards is never deleted unseen. */
export const PlanSave = z
  .object({
    rows: planRows,
    removeInstrumentIds: z.array(z.number().int().positive()).max(200),
    fingerprint: z.string().max(4000),
  })
  .strict()
  .refine((plan) => noDuplicates(plan.rows), {
    message: "An instrument appears twice in the plan",
    path: ["rows"],
  })
  .refine(
    (plan) =>
      !plan.removeInstrumentIds.some((id) => plan.rows.some((row) => row.instrumentId === id)),
    {
      message: "A row is both set and removed",
      path: ["removeInstrumentIds"],
    },
  );

export const PlanRemoveInput = z.object({ instrumentId: z.number().int().positive() }).strict();

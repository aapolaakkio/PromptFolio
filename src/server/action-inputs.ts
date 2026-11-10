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

/** `fingerprint` is filled by a chat card, so a plan changed since the card is refused. */
export const PlanRemoveInput = z
  .object({
    instrumentId: z.number().int().positive(),
    fingerprint: z.string().max(4000).optional(),
  })
  .strict();

const accountKind = z.enum(["brokerage", "bank"]);

/** Each kind's own types: brokerage is a regular securities account or an equity savings account (OST, which decides taxation); bank is current, savings or fixed-term (which decides whether money can be reached). Kept apart: neither set means anything for the other kind. */
export const BROKERAGE_TYPES = ["aot", "ost", "other"] as const;
// "credit" is a bank-kind account holding no money of its own (card purchases and settling payments), kept out of cash figures (see valuation.ts `cashTxns`); no rate or maturity.
export const BANK_TYPES = ["current", "savings", "fixed_term", "credit"] as const;

const accountType = z.enum([...BROKERAGE_TYPES, ...BANK_TYPES]);

/** A fixed-term deposit's terms. The rate stays a decimal string ("3.25") here, so a card re-validated in the browser still matches the form; storage converts it to basis points. */
const terms = {
  maturityDate: IsoDateSchema.nullable().optional(),
  interestRate: z
    .string()
    .regex(/^\d{1,2}([.,]\d{1,2})?$/, "Rate in the format 3.25")
    .nullable()
    .optional(),
};

/** Name and type only: broker and base currency are what stored rows were interpreted under. The type is editable because it decides tax treatment and a guessed, frozen one makes a tax report confidently wrong. */
export const UpdateAccount = z
  .object({
    name: z.string().trim().min(1, "Name cannot be empty").max(100).optional(),
    accountType: accountType.nullable().optional(),
    ...terms,
  })
  .refine(
    (body) =>
      body.name !== undefined ||
      body.accountType !== undefined ||
      body.maturityDate !== undefined ||
      body.interestRate !== undefined,
    { message: "No fields to change" },
  );

export const EditAccountInput = z.object({
  id: z.number().int().positive(),
  changes: UpdateAccount,
});

export const CreateAccount = z.object({
  name: z.string().min(1).max(100),
  broker: z.enum(["nordnet", "op", "spankki", "danske", "other"]),
  baseCurrency: currencyField.default(EUR),
  kind: accountKind.default("brokerage"),
  // Optional at creation: an owner importing an export may not know yet which account it covers.
  accountType: accountType.optional(),
  ...terms,
});

/** A bank account's balance on a date, from which the app derives the opening balance. */
export const BalanceInput = z
  .object({
    accountId: z.number().int().positive(),
    on: IsoDateSchema,
    balance: z.string().regex(/^-?\d+([.,]\d{1,2})?$/, "Balance in the format 1234.56"),
  })
  .strict();

/** What a chat card saves: the app adds the opening balance it showed, so a ledger changed in between is refused rather than written unseen. */
export const BalanceSave = BalanceInput.extend({
  expectOpeningEur: z
    .string()
    .regex(/^-?\d+\.\d{2}$/)
    .optional(),
  expectOpeningDate: IsoDateSchema.optional(),
}).strict();

export const SnapshotQuery = z.object({ snapshotId: z.number().int().positive() });

/** A holdings statement as supplied: what the broker says was held on a date. Quantities are decimal strings, never JSON numbers. */
export const CreateSnapshot = z.object({
  accountId: z.number().int().positive(),
  asOf: IsoDateSchema,
  source: z.enum(["pdf", "vision", "manual"]),
  rows: z
    .array(
      z.object({
        instrumentId: z.number().int().positive(),
        quantity: z.string().min(1).max(40),
        nav: z.string().min(1).max(30).optional(),
        marketValue: z.string().min(1).max(30).optional(),
      }),
    )
    .min(1, "A snapshot without rows says nothing")
    .max(200),
  statedTotalEur: z.string().max(30).nullable().optional(),
});

/**
 * Resolves one reconciliation row into a transaction. `costEur` is required when units arrive and refused when they leave:
 * a defaulted-to-zero cost would report the holding's whole value as gain. The UI may offer the statement's NAV, but a person chooses the stored figure.
 */
export const AdjustInput = z.object({
  snapshotId: z.number().int().positive(),
  instrumentId: z.number().int().positive(),
  costEur: z.string().min(1).max(30).optional(),
});

/** What a chat card saves: the app adds the signed quantity it showed, so a ledger changed in between is refused rather than corrected unseen. */
export const AdjustSave = AdjustInput.extend({
  expectQuantity: z.string().max(40).optional(),
});

export const Isin = z.string().regex(/^[A-Z]{2}[A-Z0-9]{9}\d$/, "ISIN is invalid");

/** A new instrument as the instrument form sends it. */
export const InstrumentCreate = z
  .object({
    // Optional only for `manual`: a delisted share has no ISIN any registry gives.
    isin: Isin.optional(),
    ticker: z.string().min(1).max(20).nullable(),
    name: z.string().min(1).max(200),
    kind: z.enum(["stock", "etf", "fund", "cash"]),
    currency: currencyField,
    priceSource: z.enum(["yahoo", "page", "manual"]),
    sourceKey: z.string().max(MAX_PAGE_URL).optional(),
  })
  .refine((body) => !tooLongKey(body.priceSource, body.sourceKey), {
    message: KEY_TOO_LONG,
    path: ["sourceKey"],
  })
  .refine((body) => body.priceSource === "manual" || (body.sourceKey ?? "") !== "", {
    message: "Source code is required when the price source fetches prices automatically",
    path: ["sourceKey"],
  })
  .refine((body) => body.priceSource === "manual" || (body.isin ?? "") !== "", {
    message: "ISIN is required when the price source fetches prices automatically",
    path: ["isin"],
  });

/** The owner's own ongoing charge in percent ("0,20"); empty clears it. */
export const FundChargeInput = z
  .object({ id: z.number().int().positive(), percent: z.string().max(20) })
  .strict();

export const CashEntryRemove = z.object({ id: z.number().int().positive() }).strict();

/** `expectCount` is filled by a chat card: the number of rows it said would be removed. */
export const UndoInput = z.object({
  importId: z.number().int().positive(),
  expectCount: z.number().int().min(0).optional(),
});

export const ConversationId = z.object({ id: z.number().int().positive() });

const RulePattern = z.string().trim().min(3).max(60);

export const SpendingRulesSave = z
  .object({
    rules: z
      .array(z.object({ pattern: RulePattern, category: z.string() }))
      .min(1)
      .max(50),
    /** Set by a chat card: all rules or none, never a partial save behind a failure. */
    refuseExisting: z.literal(true).optional(),
  })
  .strict();

const RuleSource = z.enum(["seed", "ai", "user"]);

/** `expectCategory` is filled by a chat card, so a rule changed since the card is refused, not overwritten. */
export const SpendingRuleChange = z
  .object({
    pattern: RulePattern,
    category: z.string().max(60),
    expectCategory: z.string().max(60).optional(),
  })
  .strict();

export const SpendingRuleRemove = z
  .object({
    pattern: z.string().min(1).max(120),
    expectCategory: z.string().max(60).optional(),
    expectSource: RuleSource.optional(),
  })
  .strict();

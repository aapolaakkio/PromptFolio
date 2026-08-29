import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import { EUR, type Currency } from "../../core/money";

// --- Better Auth tables (Task 8 generates the migration; shape fixed by the adapter) ---

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
  image: text("image"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const session = sqliteTable("session", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const account = sqliteTable("account", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  // Better Auth 1.7.2's account model requires `issuer` (the stable
  // provider-side key, e.g. "local:credential" for email/password) - the
  // installed @better-auth/drizzle-adapter throws at query time without it.
  // Not present in an older Better Auth generation; see task-8-report.md.
  issuer: text("issuer").notNull(),
  password: text("password"),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp_ms" }),
  refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp_ms" }),
  scope: text("scope"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const verification = sqliteTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

// --- Application tables ---

export const accounts = sqliteTable(
  "accounts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    broker: text("broker", { enum: ["nordnet", "op", "spankki", "danske", "other"] }).notNull(),
    /**
     * What kind of account this is: a brokerage one (arvo-osuustili,
     * osakesäästötili) or a bank one (current, savings, fixed-term deposit).
     *
     * The distinction is the owner's to make, not the importer's: a bank
     * statement looks identical whether the account behind it is a current
     * account or a savings account, so nothing in the file could tell them
     * apart. It matters because the three bank kinds hold cash that counts
     * toward what the portfolio is worth but is not invested capital -- their
     * movements must never reach the return figures, or a grocery payment would
     * read as money pulled out of the portfolio.
     *
     * Nullable because it is genuinely unknown for an account
     * created before this column existed, and a wrong answer here is worse than
     * no answer: inside an OST, trades and dividends are untaxed and tax falls
     * only on withdrawal, so phase 4 must refuse to report on an account whose
     * type nobody has confirmed rather than assume the ordinary case. Set by the
     * owner, never inferred from the broker's numbering (spec §10c/C7).
     */
    /**
     * Whether this account holds investments or money. The two are different
     * kinds of thing, not two flavours of one: a brokerage account has an
     * arvo-osuustili or osakesäästötili nature that decides its tax treatment,
     * a bank account has a current/savings/fixed-term nature that decides
     * nothing about tax and everything about whether the money is reachable.
     * Neither one's types mean anything applied to the other.
     */
    kind: text("kind", { enum: ["brokerage", "bank"] })
      .notNull()
      .default("brokerage"),
    accountType: text("account_type", {
      enum: ["aot", "ost", "current", "savings", "fixed_term", "other"],
    }),
    /**
     * When a fixed-term deposit (määräaikaistili) comes free. Null on every
     * other kind of account, including an ordinary savings account, whose money
     * is available at any time -- that is the whole difference between them.
     */
    maturityDate: text("maturity_date"),
    /**
     * The account's interest rate in basis points -- 3,25 % is 325 -- for the
     * same reason money is stored in minor units: a rate that round-trips
     * through a float eventually prints wrong. Optional on both savings kinds
     * (an ordinary account's rate is variable, so a stored one is a note about
     * today, not a promise), null everywhere else.
     */
    interestRateBp: integer("interest_rate_bp"),
    // Any ISO 4217 code, not a closed enum -- see core/money.ts's `Currency`.
    // This column has no runtime CHECK constraint; the guarantee comes from
    // every write going through `parseCurrency` first (import/map.ts,
    // the api/* zod schemas), not from SQLite.
    baseCurrency: text("base_currency").$type<Currency>().notNull().default(EUR),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [index("accounts_user_idx").on(t.userId)],
);

export const instruments = sqliteTable("instruments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  /**
   * Null only for an instrument no registry carries and nothing can price: a
   * delisted share, or a temporary line from a corporate action (a rights issue's
   * 2023 interim shares). Such a holding is matched by name instead, which is
   * how OP's ISIN-less paste already resolves everything. SQLite treats NULLs
   * as distinct, so the unique index still ties every real ISIN to one
   * instrument -- absence is recorded honestly rather than filled with an
   * invented identifier, which would silently merge or split positions.
   */
  isin: text("isin").unique(),
  ticker: text("ticker"),
  name: text("name").notNull(),
  kind: text("kind", { enum: ["stock", "etf", "fund", "cash"] }).notNull(),
  // Any ISO 4217 code -- see the comment on accounts.baseCurrency above.
  currency: text("currency").$type<Currency>().notNull(),
  priceSource: text("price_source", {
    enum: ["yahoo", "nordnet_fund", "op_fund", "manual"],
  }).notNull(),
  sourceKey: text("source_key").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

export const imports = sqliteTable("imports", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  kind: text("kind", {
    enum: ["csv_nordnet", "csv_op", "csv_bank", "pdf", "vision", "manual"],
  }).notNull(),
  filename: text("filename").notNull(),
  sha256: text("sha256").notNull(),
  status: text("status", { enum: ["draft", "committed", "undone"] })
    .notNull()
    .default("draft"),
  rowCount: integer("row_count").notNull().default(0),
  // Set once, at commit time (commit.ts's commitDraft), from the exact counts its own
  // insert loop produced. Not derivable later from `transactions` alone: after an
  // undo, every row this import inserted is gone (see commit.ts's undoImport), and a
  // skipped/duplicate row was never inserted at all, so there is never a `transactions`
  // row to count it from in the first place. `/api/imports`'s history listing (the
  // gap this closes -- an import id used to appear once in a success toast and then be
  // lost) is what actually reads these back.
  insertedCount: integer("inserted_count").notNull().default(0),
  skippedCount: integer("skipped_count").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

export const transactions = sqliteTable(
  "transactions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    instrumentId: integer("instrument_id").references(() => instruments.id),
    type: text("type", {
      enum: [
        "BUY",
        "SELL",
        "DIVIDEND",
        "FEE",
        "INTEREST",
        "DEPOSIT",
        "WITHDRAWAL",
        "SPLIT",
        "TRANSFER_IN",
        "TRANSFER_OUT",
        "OPENING_BALANCE",
      ],
    }).notNull(),
    tradeDate: text("trade_date").notNull(),
    quantity: integer("quantity").notNull().default(0), // scaled 1e6
    unitPrice: integer("unit_price"), // minor units
    amount: integer("amount").notNull().default(0), // minor units, signed
    fee: integer("fee").notNull().default(0),
    tax: integer("tax").notNull().default(0),
    // Any ISO 4217 code -- see the comment on accounts.baseCurrency above.
    currency: text("currency").$type<Currency>().notNull(),
    fxRateEur: integer("fx_rate_eur").notNull(), // scaled 1e8
    externalId: text("external_id"),
    contentHash: text("content_hash").notNull(),
    importId: integer("import_id").references(() => imports.id),
    note: text("note"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [
    unique("txn_external_uq").on(t.accountId, t.externalId),
    unique("txn_hash_uq").on(t.accountId, t.contentHash),
    index("txn_account_date_idx").on(t.accountId, t.tradeDate),
    index("txn_import_idx").on(t.importId),
  ],
);

export const snapshots = sqliteTable("snapshots", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  accountId: integer("account_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  asOf: text("as_of").notNull(),
  source: text("source", { enum: ["pdf", "vision", "manual"] }).notNull(),
  importId: integer("import_id").references(() => imports.id),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

export const snapshotRows = sqliteTable("snapshot_rows", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  snapshotId: integer("snapshot_id")
    .notNull()
    .references(() => snapshots.id, { onDelete: "cascade" }),
  instrumentId: integer("instrument_id")
    .notNull()
    .references(() => instruments.id),
  quantity: integer("quantity").notNull(),
  nav: integer("nav").notNull(),
  marketValue: integer("market_value").notNull(),
});

/**
 * A chat thread. Conversations persist per user (spec §8) so a question can
 * follow on from the last one; they are scoped to their owner like every other
 * ledger row, never shared across a family instance.
 */
/**
 * What a payment was for, as a pattern matched against the text the bank prints.
 *
 * In the database rather than in code because the set is never finished: every
 * statement brings shops nobody wrote a rule for, and the owner (or the
 * assistant, on import) should be able to teach it one without a deployment.
 *
 * `source` records who decided: "seed" for the built-in Finnish merchants,
 * "ai" for a classification the assistant proposed, "user" for one entered by
 * hand. Kept because a rule the model guessed is a weaker claim than one a
 * person made, and a wrong bucket is easier to find when you can see which
 * rules came from where.
 */
export const spendingRules = sqliteTable(
  "spending_rules",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** Upper-cased substring of the payment's text. */
    pattern: text("pattern").notNull(),
    category: text("category").notNull(),
    source: text("source", { enum: ["seed", "ai", "user"] })
      .notNull()
      .default("user"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [unique("spending_rule_uq").on(t.userId, t.pattern)],
);

export const conversations = sqliteTable("conversations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  title: text("title"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

/**
 * One turn in a thread. `content` holds the message's text; tool calls and their
 * results are deliberately not stored -- they are derived from the ledger on
 * demand, and keeping a copy would let a stale answer outlive the data it came
 * from. `toolCalls` records only which tools ran, so an answer can be audited
 * for where its figures came from.
 */
export const chatMessages = sqliteTable("chat_messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  conversationId: integer("conversation_id")
    .notNull()
    .references(() => conversations.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["user", "assistant"] }).notNull(),
  content: text("content").notNull(),
  toolCalls: text("tool_calls"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

export const prices = sqliteTable(
  "prices",
  {
    instrumentId: integer("instrument_id")
      .notNull()
      .references(() => instruments.id, { onDelete: "cascade" }),
    date: text("date").notNull(),
    close: integer("close").notNull(),
    // Any ISO 4217 code -- see the comment on accounts.baseCurrency above.
    currency: text("currency").$type<Currency>().notNull(),
    source: text("source").notNull(),
    fetchedAt: integer("fetched_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.instrumentId, t.date] })],
);

export const fxRates = sqliteTable(
  "fx_rates",
  {
    date: text("date").notNull(),
    // Any non-EUR ISO 4217 code -- previously hardcoded to `['USD']`, which
    // is exactly the widening this task exists to remove (§10a A1: the
    // real portfolio holds SEK, never USD). Nothing at the type level
    // excludes EUR itself; that a fx_rates row is never written for EUR is
    // an application-level invariant (EUR converts to itself at rate 1,
    // never looked up here), not one this column enforces.
    currency: text("currency").$type<Currency>().notNull(),
    rateEur: integer("rate_eur").notNull(), // scaled 1e8
  },
  (t) => [primaryKey({ columns: [t.date, t.currency] })],
);

export const priceFetchLog = sqliteTable(
  "price_fetch_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    source: text("source").notNull(),
    instrumentId: integer("instrument_id").references(() => instruments.id, {
      onDelete: "cascade",
    }),
    runAt: integer("run_at", { mode: "timestamp_ms" }).notNull(),
    ok: integer("ok", { mode: "boolean" }).notNull(),
    message: text("message"),
  },
  (t) => [index("price_log_run_idx").on(t.runAt)],
);

/**
 * At most one row per instrument, tracking a price the plausibility check
 * (`src/server/prices/write.ts`) has rejected as an implausible jump but
 * has not yet confirmed as a real, permanent re-baseline (a stock split,
 * a reverse split, a fund NAV re-denomination). Reviewer finding on Task
 * 15: comparing every new point only against the last *stored* price
 * means a genuine permanent change would be rejected forever -- every
 * later real price also fails against the same frozen stale baseline,
 * and there is no price-correction UI anywhere in this app to unstick it
 * by hand. This table is what lets `writePrices` tell a transient glitch
 * apart from a real, permanent change: a glitch does not repeat at a
 * consistent new scale across several separate refreshes; a real split
 * or re-denomination does. See `write.ts`'s `RE_BASELINE_CONFIRMATIONS`
 * comment for the exact rule and its justification.
 */
export const pendingPriceRejections = sqliteTable("pending_price_rejections", {
  instrumentId: integer("instrument_id")
    .notNull()
    .primaryKey()
    .references(() => instruments.id, { onDelete: "cascade" }),
  date: text("date").notNull(),
  close: integer("close").notNull(),
  // Any ISO 4217 code -- see the comment on accounts.baseCurrency above.
  currency: text("currency").$type<Currency>().notNull(),
  // How many consecutive refreshes have now reported a value consistent
  // with this pending candidate (not necessarily identical -- see
  // write.ts). Reset to 1 whenever a genuinely new, unrelated anomaly
  // starts; the row is deleted entirely once either resolved (streak
  // reaches the confirmation threshold and the candidate is accepted) or
  // abandoned (a later point turns out plausible against the real stored
  // baseline again, i.e. the anomaly was transient after all).
  streak: integer("streak").notNull(),
});

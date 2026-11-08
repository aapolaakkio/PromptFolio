import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import { EUR, type Currency } from "../../core/money.ts";

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
     * Whether this account holds investments or money -- different kinds of
     * thing, not two flavours of one, and neither's types mean anything applied
     * to the other.
     *
     * The owner's call, never the importer's: a bank statement looks identical
     * whichever kind is behind it. It matters because a bank account's cash
     * counts toward what the portfolio is worth without being invested capital,
     * and its movements must never reach the return figures.
     *
     * Nullable because it is genuinely unknown for an account created before the
     * column existed, and no answer beats a wrong one: inside an OST tax falls
     * only on withdrawal, so a report must refuse an unconfirmed account rather
     * than assume the ordinary case.
     */
    kind: text("kind", { enum: ["brokerage", "bank"] })
      .notNull()
      .default("brokerage"),
    accountType: text("account_type", {
      enum: ["aot", "ost", "current", "savings", "fixed_term", "credit", "other"],
    }),
    /**
     * When a fixed-term deposit comes free. Null everywhere else, including an
     * ordinary savings account, whose money is available at any time.
     */
    maturityDate: text("maturity_date"),
    /**
     * Basis points -- 3,25 % is 325 -- for the same reason money is in minor
     * units. Optional on a savings account, whose variable rate makes a stored
     * one a note about today rather than a promise.
     */
    interestRateBp: integer("interest_rate_bp"),
    // Any ISO 4217 code. No CHECK constraint: the guarantee is that every write
    // goes through `parseCurrency` first, not anything SQLite enforces.
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
   * Null only for an instrument no registry carries: a delisted share, or a
   * temporary line from a corporate action. Matched by name instead. SQLite
   * treats NULLs as distinct, so the unique index still ties every real ISIN to
   * one instrument, and an invented one would silently merge positions.
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
    enum: ["csv_nordnet", "csv_op", "csv_bank", "csv", "paste", "pdf", "vision", "manual"],
  }).notNull(),
  filename: text("filename").notNull(),
  sha256: text("sha256").notNull(),
  status: text("status", { enum: ["draft", "committed", "undone"] })
    .notNull()
    .default("draft"),
  rowCount: integer("row_count").notNull().default(0),
  // Set once at commit time and not derivable later: an undone import's rows are
  // gone, and a skipped one was never inserted at all.
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
    // Any ISO 4217 code. That EUR never gets a row -- it converts to itself at
    // rate 1 -- is an application invariant, not one this column enforces.
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
 * One row per instrument whose price the plausibility check refused but has not
 * yet confirmed as a real permanent change. What lets `writePrices` tell a
 * transient glitch from a split: a glitch does not repeat at the same new scale
 * across refreshes, a split does.
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
  // Consecutive refreshes reporting a value consistent with this candidate --
  // not necessarily identical. The row goes once it is accepted or abandoned.
  streak: integer("streak").notNull(),
});

/**
 * What share of the portfolio the owner wants one slice to hold.
 *
 * Basis points as an integer, so "sums to exactly 100 %" is a check on integers
 * rather than an epsilon comparison that is wrong twice a year.
 *
 * Bound to one dimension: 60 % equities and 50 % at one broker are each
 * reasonable and jointly unsatisfiable, and no useful drift comes out of a
 * contradiction.
 */
export const allocationTargets = sqliteTable(
  "allocation_targets",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    dimension: text("dimension", {
      enum: ["kind", "currency", "account", "instrument"],
    }).notNull(),
    /** The slice this targets: `core/allocation.ts`'s `Slice.key` for that dimension. */
    key: text("key").notNull(),
    weightBp: integer("weight_bp").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [unique().on(t.userId, t.dimension, t.key)],
);

/**
 * A layout the model has already described, keyed by the shape of a document's
 * opening lines. Per user and never shared: a recipe may legitimately quote a
 * literal from the owner's own statement.
 */
export const importRecipes = sqliteTable(
  "import_recipes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    fingerprint: text("fingerprint").notNull(),
    kind: text("kind", {
      enum: ["bank", "bank-csv", "broker-table", "broker-record", "holdings"],
    }).notNull(),
    /** The validated recipe as JSON, of the kind named beside it. Re-validated on read. */
    recipe: text("recipe").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => [unique().on(t.userId, t.fingerprint)],
);

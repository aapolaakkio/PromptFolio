# PromptFolio — Design

Date: 2026-08-27
Status: Approved (design). Phase 1 is specified in full; later phases are scoped but get their own specs.

## 1. Purpose

A self-hosted portfolio manager for a Finnish investor holding EUR and USD instruments across
Nordnet, OP, S-Pankki and Danske, covering both listed securities and non-listed mutual funds.

It must answer four questions the current spreadsheet cannot:

1. What is my portfolio worth, and how has it actually grown?
2. (chat) Whatever I feel like asking about my own holdings.
3. Where have I drifted from my target allocation, and what am I paying in fees?
4. What do I owe in Finnish capital gains tax, and what goes on the Vero form?

Users: the author plus family members. Self-hosted, not a public SaaS.

## 2. Scope

**Phase 1 (this spec):** ledger, CSV import, price/NAV layer, holdings view, growth chart, auth.

Later phases, each with its own spec:

- Phase 2 — reconciliation UI, PDF import, screenshot/vision import
- Phase 3 — AI chat with tool-calling
- Phase 4 — Finnish tax module and Vero export
- Phase 5 — rebalancing, drift and fee analysis

Sections 3–7 describe the whole system, because phase 1 must not paint later phases into a
corner. Section 10 states precisely what phase 1 delivers.

## 3. Architecture

One Bun 1.4 process serves the API, the built React SPA, and the scheduled price refresh.
Three source trees:

```
src/core/     pure domain logic — no I/O, no DB, no network
src/server/   HTTP routes, SQLite access, importers, price sources, scheduler
src/web/      React SPA
```

`src/core` holds every calculation whose wrongness would matter: cost basis, returns,
allocation, reconciliation diffs, FX conversion, tax lots. It takes plain data in and returns
plain data out, so it is testable without fixtures, mocks, or a database.

**Storage: SQLite via `bun:sqlite`.** Single file. Backup is a file copy. At personal scale
(low thousands of transactions) no query needs optimising.

**Deployment:** Docker on a small VPS, or `bun run` on a home machine. One container, one
volume for the SQLite file.

### 3.1 Module boundaries

| Module | Responsibility | Depends on |
|---|---|---|
| `core/ledger` | Derive positions and cash from transactions | — |
| `core/costbasis` | FIFO lots, realised/unrealised gains | `core/ledger` |
| `core/returns` | Value series, TWR, MWR/XIRR | `core/ledger`, prices |
| `core/allocation` | Grouping by kind, currency, sector, account | `core/ledger` |
| `core/reconcile` | Diff derived positions against a snapshot | `core/ledger` |
| `core/money` | Scaled-integer money and quantity arithmetic | — |
| `server/db` | Schema, migrations, typed queries | — |
| `server/import/*` | One module per source format | `core/*` |
| `server/prices/*` | One module per price source | — |
| `server/api` | HTTP routes, auth, validation | everything |

Rule: `src/core` may not import from `src/server`. Enforced by a lint rule, because this is the
boundary that erodes first.

## 4. Data model

Transactions are **append-only**. Nothing UPDATEs or DELETEs a transaction row. A mistake is
corrected by a reversing or adjusting entry. This gives the tax module an audit trail and makes
every derived number reproducible from the ledger alone.

```sql
users(id, email UNIQUE, password_hash, created_at)

accounts(id, user_id, name, broker, base_currency, created_at)
  -- broker: 'nordnet' | 'op' | 'spankki' | 'danske' | 'other'

instruments(id, isin, ticker, name, kind, currency,
            price_source, source_key, created_at)
  -- kind: 'stock' | 'etf' | 'fund' | 'cash'
  -- price_source: 'yahoo' | 'nordnet_fund' | 'op_fund' | 'spankki_fund'
  --             | 'danske_fund' | 'manual'
  -- source_key: the identifier that source needs (ticker, fund id, URL slug)
  UNIQUE(isin)

transactions(id, account_id, instrument_id NULL, type, trade_date,
             quantity, unit_price, amount, fee, tax,
             currency, fx_rate_eur, external_id NULL, content_hash,
             import_id NULL, note, created_at)
  -- type: BUY | SELL | DIVIDEND | FEE | INTEREST
  --     | DEPOSIT | WITHDRAWAL | SPLIT | TRANSFER_IN | TRANSFER_OUT
  UNIQUE(account_id, external_id)      -- where the broker supplies an id
  UNIQUE(account_id, content_hash)     -- fallback dedupe

snapshots(id, account_id, as_of, source, import_id, created_at)
snapshot_rows(id, snapshot_id, instrument_id, quantity, nav, market_value)

prices(instrument_id, date, close, currency, source, fetched_at)
  PRIMARY KEY(instrument_id, date)

fx_rates(date, currency, rate_eur)
  PRIMARY KEY(date, currency)

imports(id, user_id, kind, filename, sha256, status, row_count, created_at)
  -- kind: 'csv_nordnet' | 'csv_op' | 'pdf' | 'vision' | 'manual'
  -- status: 'draft' | 'committed' | 'undone'

price_fetch_log(id, source, instrument_id NULL, run_at, ok, message)

sessions(id, user_id, expires_at, created_at)
```

### 4.1 Money and quantities

Floating point is not used for money. `core/money` represents amounts as integer minor units
with an explicit currency, and quantities as integers scaled by 10^6 (funds are held in
fractional units). All arithmetic goes through this module; rounding is explicit at every
division, with the rounding mode named at the call site.

### 4.2 Currency and FX

Most holdings are EUR; some are USD. Every transaction stores its own `currency` and the EUR
rate applying on its `trade_date`, frozen at import time and never recomputed — the tax module
needs the historical rate, not today's.

EUR transactions store `fx_rate_eur = 1` and skip the FX path entirely.

`fx_rates` is filled from the ECB daily reference rate CSV (`eurofxref`), fetching only the
currencies that appear in the ledger. ECB publishes on TARGET business days; weekends and
holidays resolve to the most recent prior rate.

### 4.3 Opening positions

Broker exports may not reach back to the first purchase. An **opening position** flow records a
`TRANSFER_IN` with a stated date, quantity and cost basis, so that holdings predating the
available history have a defined acquisition cost. Without it, the oldest positions would report
infinite return and unusable tax figures.

## 5. Import pipeline

Every importer implements the same four stages:

```ts
parse(file)      → RawRow[]   // format-specific, no domain knowledge
map(RawRow[])    → Draft      // { transactions, snapshots, unknownInstruments }
review(Draft)                 // UI — user confirms, resolves unknowns
commit(Draft)    → importId   // one SQLite transaction, dedupe applied
```

**No import reaches the ledger without passing review.** Broker CSV column meanings change
between export versions and OCR misreads digits; review is where that is caught. This is a
correctness requirement, not a convenience.

### 5.1 CSV (phase 1)

Nordnet and OP transaction exports. Per-broker configuration objects, not code branches:

```ts
type BrokerCsvConfig = {
  broker: Broker
  encoding: 'utf-8' | 'latin1'      // Nordnet exports ISO-8859-1
  delimiter: ';' | ','
  decimal: ',' | '.'
  dateFormat: string
  columns: Record<CanonicalField, string>
  typeMap: Record<string, TransactionType>   // broker's Finnish labels → our enum
}
```

Finnish specifics handled: decimal comma, thousands separator as space or non-breaking space,
`dd.mm.yyyy` dates, and Finnish transaction-type labels (`Osto`, `Myynti`, `Osinko`,
`Talletus`, `Nosto`, and their Swedish/English variants where Nordnet emits them).

Parser output is validated against a Zod schema before mapping. A row that fails validation does
not abort the import: it is carried into the review screen marked invalid, with the raw text
shown, so the user can fix or skip it.

### 5.2 PDF and vision (phase 2, designed here)

PDF: extract the text layer first; only render pages as images for the vision model when there
is no text layer.

Vision: image → Claude with a strict JSON schema → produces a **snapshot**, never transactions.
Snapshots are low-stakes by construction: the worst outcome is a reconciliation diff the user
dismisses.

### 5.3 Unknown instruments

An import mentioning an unseen ISIN pauses and asks for name, kind, currency, price source and
source key. One-time per instrument. Guessing here would silently attach the wrong price source
and corrupt every later valuation.

### 5.4 Reconciliation (phase 2, designed here)

After a snapshot is committed, `core/reconcile` diffs derived positions at `as_of` against the
snapshot rows and reports per instrument: derived quantity, snapshot quantity, delta. Each row
resolves to *dismiss* or *generate adjusting transaction*. Fund quantities compare within a
tolerance, since brokers round fractional units differently.

### 5.5 Undo

Every row carries `import_id`. Undoing an import deletes its rows, permitted only when no later
transaction depends on them (no sale of units it introduced). This is the one exception to
append-only, and it is confined to reverting an import that was never correct.

## 6. Price and NAV layer

```ts
interface PriceSource {
  readonly id: PriceSourceId
  fetch(instrument: Instrument, range: DateRange): Promise<PricePoint[]>
}
```

| Source | Covers | Mechanism | Fragility |
|---|---|---|---|
| `yahoo` | listed stocks, ETFs | public chart endpoint, by ticker | low–medium |
| `nordnet_fund` | Nordnet fund selection | Nordnet web-app JSON API, by fund id | medium |
| `op_fund` | OP in-house funds | fund page scrape | high |
| `spankki_fund` | S-Pankki funds | fund page scrape | high |
| `danske_fund` | Danske funds | fund page scrape | high |
| `manual` | anything else | user-entered NAV | none |

**Refresh:** a scheduled job on weekday evenings (after Finnish fund NAV publication, ~19:00
Europe/Helsinki) fetches each instrument's latest close/NAV plus the ECB FX rates. Sources run
isolated — one throwing scraper must not stop the others. Every attempt writes to
`price_fetch_log`.

**Backfill:** on first import of an instrument, fetch history back to its earliest transaction so
the growth chart has real data from the start.

**Failure behaviour:** a missing price falls back to the most recent stored price, and the UI
shows a *stale* badge naming the as-of date. Never a blank chart, never a silently wrong total. A
broken scraper becomes visible within a day rather than at tax time.

**The charts never call the network.** They read `prices` and `fx_rates` only.

## 7. Returns and valuation

`core/returns`, pure functions over ledger + prices + FX:

- **Value series** — daily portfolio value: positions × price × FX, per day
- **TWR** — time-weighted, deposit-neutral, comparable to OMXH25 or a world index
- **MWR (XIRR)** — money-weighted, includes the effect of when money went in

Both are shown. TWR alone hides the consequences of your timing; MWR alone cannot be compared to
an index. Deposits and withdrawals must be present in the ledger for either to be meaningful,
which is why they are first-class transaction types.

XIRR uses Newton's method with a bisection fallback for the cases where Newton fails to converge
(sign changes, extreme cashflow patterns). Tested against known-answer fixtures.

## 8. AI chat (phase 3, designed here)

Chat is **tool-calling, read-only**. The model never sees the database and never writes.

Tools are thin wrappers over the same `core` functions the UI calls, so chat and dashboard cannot
disagree:

`get_holdings`, `get_allocation`, `get_returns`, `get_transactions`, `get_dividends`,
`get_instrument`, `get_value_series`

Every tool result carries its `as_of` date and staleness flag, so answers can say "as of 12.8.,
NAV stale". System prompt rule: **every figure must come from a tool result; the model performs
no arithmetic in prose.**

Implementation: `@anthropic-ai/sdk`, model `claude-opus-5`, adaptive thinking
(`thinking: { type: 'adaptive' }`), `output_config.effort` tuned per route, streaming responses,
and the beta tool runner (`client.beta.messages.toolRunner` with `betaZodTool`) so the loop is
the SDK's rather than ours. Server-side refusal fallbacks are enabled. Tool arguments are
validated by Zod before execution — the model's output is external data like any other.

Conversations persist per user. Cost at personal volume is cents per session.

## 9. Cross-cutting concerns

### 9.1 Error handling

Three classes, handled differently:

| Class | Examples | Behaviour |
|---|---|---|
| Ingest | malformed CSV row, OCR garbage | never reaches the ledger; shown in review with the offending raw row |
| External | scraper down, HTTP 429, ECB gap | logged to `price_fetch_log`, degrade to stale, retry next cycle; badge in UI |
| Domain | sell more units than held, negative cash | rejected at commit with a message naming the instrument and date |

No error is swallowed. Server logs carry full context; UI messages are specific and actionable
and never contain stack traces or internal identifiers.

### 9.2 Validation

Zod schemas at every boundary: HTTP request bodies, parser output, price-source responses, LLM
tool arguments, LLM vision output. External data is never trusted, and that includes data
produced by the model.

### 9.3 Security

- Session cookies: `httpOnly`, `sameSite=lax`, `secure` when served over HTTPS
- Argon2id password hashing
- Every query scoped by `user_id`; no route derives ownership from a client-supplied id alone
- Rate limits on login, import, and chat
- `ANTHROPIC_API_KEY` from environment only, validated at startup — the process refuses to boot
  without it once phase 3 lands
- No secrets in the SQLite file; no amounts, holdings or keys in logs

### 9.4 Testing

Target: 80% coverage, TDD throughout (`bun test`).

- **Unit** — all of `core`: FIFO cost basis, XIRR against known-answer fixtures, TWR across
  deposit events, allocation, reconciliation diff, FX conversion, money rounding. Pure functions,
  no mocks.
- **Integration** — importers against anonymised real Nordnet/OP CSV fixtures; API routes against
  a temporary SQLite file; price sources against recorded HTTP fixtures.
- **E2E** — import a CSV, verify holdings, verify the chart renders, and (phase 3) ask chat a
  question and check the number matches the ledger.

**No live network calls in the test suite.** Scrapers must never make CI flaky.

### 9.5 Frontend

React with TanStack Router, Query, Table and Charts.

`@tanstack/react-charts` is at `0.16.0` and pre-1.0. All chart usage goes through three local
wrappers — `TimeSeriesChart`, `AllocationChart`, `BarChart` — so replacing the library is a
single-directory change rather than a rewrite.

Screens: Dashboard (value, growth chart, allocation, movers), Holdings (TanStack Table, grouped
by account/kind/currency), Instrument detail, Imports, and — from phase 3 — Chat.

All amounts render in Finnish locale (`fi-FI`): decimal comma, space thousands separator, EUR
formatting. USD-denominated positions show both the native amount and the EUR conversion.

## 10. Phase 1 deliverables

Done means all of the following, with tests:

1. Bun server serving API and SPA, SQLite schema with migrations
2. Email/password auth, sessions, multi-user with per-user scoping
3. Account CRUD
4. Nordnet and OP CSV import: parse → map → review → commit, with dedupe and undo
5. Unknown-instrument resolution flow
6. Opening-position flow
7. Price layer with `yahoo`, `nordnet_fund`, `op_fund`, `spankki_fund`, `danske_fund`, `manual`;
   scheduled refresh; backfill; stale badges; `price_fetch_log`
8. ECB FX ingestion for currencies present in the ledger
9. `core`: ledger, money, cost basis, returns (value series, TWR, XIRR), allocation
10. Dashboard with value + growth chart and allocation breakdown
11. Holdings table with per-position quantity, cost basis, market value, unrealised gain, weight
12. Docker deployment

Explicitly **not** in phase 1: reconciliation UI, PDF import, vision import, chat, tax, rebalancing.

## 10a. Amendment — 2026-08-27, after inspecting real broker exports

The user supplied a real Nordnet transaction export, a real Nordnet holdings export, a real OP
year-end PDF statement, and a screenshot of OP's web transaction view. Four assumptions in sections
4-6 were falsified. This amendment supersedes them.

### A1. Currency is any ISO 4217 code, not `EUR | USD`

The real portfolio holds EUR and **SEK**; it holds no USD at all. Two ETFs whose names contain
"USD" trade in EUR — the name is not the currency.

`Currency` becomes a validated 3-letter ISO code rather than a two-member union. `fx_rates`
accepts any non-EUR currency. Task 15's ECB ingestion fetches whatever currencies appear in the
ledger, defaulting to none rather than to USD.

### A2. Nordnet exports are UTF-16LE, tab-delimited

Both Nordnet exports are UTF-16 little-endian with a BOM and tab separators, not UTF-8 with
semicolons. §5.1's `BrokerCsvConfig` example is wrong on both counts. Column *names* were correct.

The transaction export also has **five columns named `Valuutta`**. A parser that maps header name
to value silently keeps the last, which is the commission currency, not the transaction currency.
Column identity must therefore be positional, not by name alone.

Its real transaction types are: OSTO, MYYNTI, TALLETUS, NOSTO, ETF_KK SÄÄSTÖN PALVELUMAKSU,
PER ETF-KK SÄÄSTÖN PALVEMAKSU (Nordnet's own typo), PÄÄOMIT YLIT.KORKO, LAINAKORKO,
VAIHTO AP-OTTO, VAIHTO AP-JÄTTÖ, DESIM. ULOSKIRJ. KÄT, DESIM KIRJAUS OTTO, Reaaliaikainen talle.
No dividend rows appear — the holdings are accumulating funds and ETFs.

### A3. OP has no CSV export

§5.1's OP `BrokerCsvConfig` describes a file that does not exist. OP offers a PDF statement and a
web transaction view. Replaced by:

- **OP paste import (phase 1).** The user copies the OP web transaction table and pastes it in.
  The real paste is **newline-separated — one value per line, with no delimiter at all** — so it does
  not fit the delimiter-based `BrokerCsvConfig` path and needs its own parser.
  Its eight columns are `Laji`, `Tapahtuma`, `Tapahtuma-päivämäärä`, `Määrä`, `Kurssi`,
  `Kulut / Korot / Verot`, `Yhteensä`, `Toiminnot` (always empty). Two header labels wrap onto two
  lines each, so the header block is ten lines for eight columns, and rows are separated by a line
  containing a single space.
  **A missing fee omits its line entirely rather than emitting an empty cell**, so a row is six or
  seven values and the column each value belongs to must be derived from that count — the last value
  is always `Yhteensä`. Parsing positionally would book a purchase total as a fee.
  Two consequences: the web view carries **no ISIN**, so instruments resolve by name via the
  unknown-instrument flow; and its total is **unsigned**, so the sign is derived from the
  OSTO/MYYNTI type column rather than read from the amount.
- **OP PDF (phase 2, unchanged).** The PDF has a real text layer and is a year-end *holdings*
  statement listing acquisition lots — it feeds opening positions (§4.3), not the transaction path.

### A4. Broker FX rate is preferred over ECB

Nordnet's transaction export carries a per-row `Vaihtokurssi`. Where present it is the rate actually
applied to the trade, including spread, so it is preferred. The ECB daily rate remains the fallback
for rows with no broker rate. §4.2's frozen-rate rule is unchanged; only the source order is
specified. Each transaction records which source its rate came from.

## 11. Open questions

- Whether Nordnet's transaction export reaches back to account opening or only a recent window.
  Resolved either way by the opening-position flow (§4.3), so it does not block phase 1.
- Whether `nordnet_fund` NAV access needs an authenticated session. If it does, that source
  degrades to `manual` for phase 1 and gets its own investigation.
- Exact Finnish tax rules (FIFO vs. hankintameno-olettama, the 30%/34% bracket boundary,
  85%-taxable listed dividends) are deliberately deferred to the phase 4 spec and must be
  verified against vero.fi at that time rather than assumed.

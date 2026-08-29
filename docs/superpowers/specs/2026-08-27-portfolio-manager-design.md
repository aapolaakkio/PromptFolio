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
| Domain | negative cash | rejected at commit with a message naming the instrument and date |
| Domain | sell more units than held | **not** rejected at commit, by design — see §10b |

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

### A5. Price sources, verified — Task 14, 2026-08-27

§6's table guessed a mechanism per source. All four guesses were wrong in some way once checked
against a real fetch; here is what each source actually does, and why `spankki_fund`/`danske_fund`
ship unimplemented.

- **`yahoo`** — the guessed public chart endpoint
  (`query1.finance.yahoo.com/v8/finance/chart/{ticker}`) is real and needs no auth; verified by
  fetching `NOKIA.HE` directly. `meta.currency` is trusted as observed (any ISO 4217 code via
  `parseCurrency`), not narrowed to `EUR | USD` — an ETF quoted in a third currency is possible and
  must not be silently misreported.
- **`nordnet_fund`** — the guessed `/api/2/instruments/historical/prices/{isin}` JSON endpoint is
  real but returns `401 NEXT_INVALID_SESSION` without a logged-in session; **this resolves the open
  question below: yes, it needs an authenticated session.** It does *not* degrade to `manual`,
  though — each fund's own public detail page
  (`nordnet.fi/rahastot/lista/{slug}`) is server-rendered and needs no session, and was found (by
  fetching both the user's EUR fund and their SEK fund) to embed the fund's `latestNav` and
  `previousNav` directly in the HTML. This is a real but limited source: two NAV points per fetch,
  not a history: a daily refresh job can still accumulate history over time. See
  `src/server/prices/funds.ts`'s `NORDNET_FUND` comment for the full finding, including how the SEK
  fund's currency was confirmed to come through unchanged.
- **`op_fund`** — the guessed `data-nav="..."` attribute does not exist anywhere on the page. The
  real fact sheet (`op.fi/.../rahastot/kaikki-rahastot/{slug}`) is plain server-rendered HTML with no
  client-side rendering involved, and states the NAV as `<dt>Osuuden arvo (26.08.)</dt><dd>283,60
  EUR</dd>` — verified against the real OP-Maailma Indeksi page.
- **`spankki_fund` / `danske_fund`** — **not implemented.** No S-Pankki or Danske holding appears in
  any real export or paste seen so far; both banks were named
  during planning as *possibly* held, but that was never confirmed. Writing scrapers against guessed
  selectors for an unconfirmed holding is the same mistake A2/A3 above already document once each
  (wrong Nordnet encoding/delimiter, an OP CSV format that doesn't exist) — so both stay in the
  `PriceSourceId` union and the registry, wired to an explicit not-yet-implemented source that
  behaves exactly like `manual`, rather than to a guessed scraper. Any instrument on either bank
  should be configured with `price_source: 'manual'` until a real holding and a real page can be
  checked.

## 10b. Amendment — 2026-08-27, negative-position handling

§9.1's Domain row and an earlier controller ruling both claimed a sale that exceeds the held
quantity is "rejected at commit with a message naming the instrument and date." Verified directly:
it is not implemented anywhere. `import/commit.ts` has no oversell check, and a SELL with no
matching earlier BUY commits cleanly, leaving `positionsAt` reporting a negative quantity for that
instrument (verified: a single unmatched 10-unit SELL yields quantity `-10.000000`).

Rejecting such a sale at commit is also, on reflection, the wrong fix — deliberately not done, not
merely not yet done. The user imports OP transactions by pasting one page of their web transaction
table at a time, **newest page first**, so a page legitimately contains sales whose matching
purchases are on a page not yet imported. The ledger is append-only and order-independent: state is
correct once every page has landed. Rejecting a draft that would drive a position negative mid-import
would make this paging workflow impossible.

Instead, the incomplete state is made visible rather than silently wrong, and degrades per position
rather than failing whole screens:

- `GET /api/holdings` resolves each instrument's cost basis independently
  (`costBasisPerInstrument`, `core/costbasis.ts`). An instrument with an unmatched disposal reports
  `costEur`/`valueEur`/`unrealisedEur: null` and a `costBasisError` naming the trade date and giving
  the same Finnish explanation the earlier (whole-request) 400 used to carry — every other holding
  is unaffected.
- `GET /api/allocation` and `GET /api/value-series` never fold a negative quantity into a total
  (a negative position priced and summed would silently drag the reported value down). The
  instrument is excluded from the total and named explicitly instead — `excludedInstruments` on
  `/api/allocation`, `excludedInstrumentIds` per point on `/api/value-series` — so the gap is visible
  and actionable rather than a vanished holding or a fabricated negative number.

See `.superpowers/sdd/2026-08-27-promptfolio-phase-1/fix-negative-positions-report.md` for the full
implementation report.

## 10c. Amendment — 2026-08-28, instrument resolution and cash holdings

### C1. Unknown instruments are resolved from public registries, not typed

§5.3 had the user supply an unregistered instrument's kind, currency, price source and source key
by hand. Three of those are knowable, and are now looked up (`src/server/instruments/`, exposed as
`GET /api/instruments/lookup`):

- **OpenFIGI** (`POST https://api.openfigi.com/v3/mapping`, free, no key) answers *what* the
  security is — its `securityType` maps to `instruments.kind` — and lists every venue it trades on.
  Its coverage includes Finnish non-listed funds.
- **Yahoo's search** answers *what its price is*, giving the symbol the price fetcher needs. Its
  coverage also includes Finnish non-listed funds, under synthetic `0P...` symbols, roughly a day
  behind the fund provider's own page. Verified against four real OP funds.
- **The holding's own currency decides which listing is correct.** One ISIN trades on several
  venues in different currencies (one widely held ETF is USD in London and EUR in Amsterdam), so candidate
  symbols are built from the venue list and probed until one is quoted in the currency of the rows
  the holding actually appeared in. The currency itself is never taken from a registry — it comes
  from the broker's own export, which is the only authority on what was bought.

Everything resolved is pre-filled into the form and stays editable; the user confirms it. When no
listing in the holding's currency exists, the closest one is offered *and* the mismatch stated,
rather than an error and an empty form.

For OP's paste import, which carries no ISIN column at all (A3), the fund's op.fi page is found by
slugifying its name and accepted only when the page's own ISIN or title proves it is the right
fund — so the ISIN is discovered rather than typed. A wrong guess yields the manual form, never an
instrument pointed at another fund's NAV.

**Consequence for the Finnish bank scrapers (§6, A5).** Since Yahoo covers OP's funds, `op_fund` is
now a fallback rather than the primary path — still the only route for OP's paste import, which has
no ISIN to search with.

`spankki_fund` and `danske_fund` are **removed outright**, superseding their rows in §6's source
table, §10's deliverable 7 and A5: gone from `PriceSourceId`, from the `instruments.price_source`
enum, from the registry, and from the source picker, along with `SourceNotImplementedError`, which
existed only to represent them. No migration was needed — the enum was TypeScript-only, with no
CHECK constraint in SQLite — and no stored instrument used either. A holding nothing can price is
configured as `manual` and valued by hand. No further scraper work is planned unless a holding
turns up that Yahoo genuinely cannot price.

### C2. Cash holdings — planned, not yet built

The ledger already tracks cash movements (`DEPOSIT`, `WITHDRAWAL`, `core/ledger.ts`'s `cashAt`), but
cash is deliberately excluded from portfolio value and from the returns in §7, and there is no way
to hold cash as a *position* — a savings balance, a currency account, an unspent deposit sitting at
a broker.

The user wants this supported. Requirements, to be designed properly in a later phase:

- Cash as a first-class holding, per account and per currency, valued at face value with FX applied
  the same way every other non-EUR holding is (§4.2).
- A decision, made explicitly rather than by default, on whether cash counts toward total portfolio
  value, allocation percentages, and the TWR/MWR figures — each of which changes what the headline
  numbers mean. §7's current answer ("value is positions × price × FX, cash excluded") is what this
  amendment puts up for revision.
- Interest as an income type alongside dividends, for both returns and the phase 4 tax reporting.

The `instruments.kind` enum already carries a `"cash"` member, unused today; whether cash holdings
reuse it or get their own table is a design question for that phase, not a settled decision.

### C3. ECB's flat CSV files are dead; rates now come from the SDMX API

§4.2 and A4 name `eurofxref.csv` and `eurofxref-hist.csv` as the FX source. Both were verified
dead on 2026-08-28 — still `200 OK`, still `text/csv`, and both frozen:

| URL | newest row | contents |
| --- | --- | --- |
| `eurofxref.csv` | 14 July 2017 | real rates, nine years stale |
| `eurofxref-hist.csv` | 2010-02-14 | placeholders (`2,1,2,N/A,1,2,…`), not rates |

The second one is the damaging case. Its currency columns hold single-digit placeholders, which
invert into rates off by roughly a factor of five from the truth. A holding quoted in such a
currency was valued several times too high — and reported no error at all, because a well-formed CSV parsed cleanly
into a plausible number. Live data still exists at the `.zip` variants of those URLs, which
would need unzipping inside the server.

Rates now come from ECB's SDMX data API
(`https://data-api.ecb.europa.eu/service/data/EXR/D.<CCY>.EUR.SP00.A?format=csvdata`), which
needs no unzipping, serves the current day, reaches back to 1999, takes a date range, and takes
several currencies in one request. `src/server/fx-ecb.ts` owns the fetch and parse;
`refreshFxRates`, `backfillFxRates` and `ensureFxRate` keep their existing roles, and the old
daily-then-historical two-step in `ensureFxRate` collapses into one ranged request.

**Which currencies are supported.** Any ISO 4217 code is accepted structurally (A1), but a
holding can only be *converted* in a currency ECB publishes — roughly 30, including SEK, NOK,
USD, GBP, DKK and CHF. Only the currencies the ledger actually holds are ever fetched.

**Still open: FX staleness is not checked.** `fxOn` takes the newest rate dated on or before the
valuation date, with no limit on how far before. That is correct for valuing a historical date,
and it is exactly what let a 2010 rate value a 2026 holding in silence. A distance bound — a rate
more than a few days older than the date being valued is treated as missing, surfacing the
existing `valuationError` rather than a wrong number — is wanted and not yet built.

### C4. Nordnet exports: more transaction types, and more than one account

A wider export (2026-08-28, covering a second Nordnet account rather than one) carried nine
labels A2's export never showed. Four are now mapped in `brokers.ts`:

- `OSINKO` → `DIVIDEND`. Seven dividends were being refused before this.
- `TALLETUS OST.` → `DEPOSIT` and `NOSTO OST.` → `WITHDRAWAL`. "OST." is *osakesäästötili*, a
  Finnish equity savings account — not "osto".
- `PÄÄOMATULOVERO OST` → `FEE`. Capital income tax withheld on an equity-savings withdrawal:
  the money leaves permanently but never reaches the investor, so booking it as a withdrawal
  would tell the money-weighted return it was money taken out and enjoyed. Phase 4's tax
  reporting will want these rows specifically.

Five more are refused on purpose, joining A2's four. Every one is a single leg of a two-row
event whose other leg carries the same units or the same cash: `AP OTTO` / `JÄTTÖ SIIRTO` (a
subscription commitment converting into shares, both legs at `Summa: 0`) and `LUNASTUS AP OTTO`
/ `LUNASTUS AP KÄT.` (a tender offer — one leg removes the shares, the other brings the cash,
both stating the full quantity and price). Booking either leg alone would double a position or
a cash balance.

**Two problems this export surfaces that are not yet solved:**

1. **One file, several accounts.** The export's `Salkku` column holds the account number, and
   the importer never reads it: every row is filed under the single account the user picks on
   the import screen. A multi-account export therefore merges two portfolios into one. The
   column is present in every row, so splitting by it — or refusing a file whose rows disagree
   with the chosen account — is straightforward, and undecided.
2. **Internal transfers are counted as external flows.** Cash moved between the user's own two
   Nordnet accounts appears twice: as `NOSTO` in one and `TALLETUS` in the other, each tagged
   `Internal to <number>` / `Internal from <number>` in `Tapahtumateksti`. Imported as-is, both
   count as external cash flows, which is what the money-weighted return is defined over. The
   marker text makes them identifiable; what to do with them is a returns-definition question
   tied up with C2's cash decision.


### C5. OP's paste carries corporate actions, and one of them changes the share count

A second real paste (2026-08-28) showed OP's web view emitting seven transaction types beyond the
OSTO/MYYNTI/OSINKO that A3 recorded, all of them one issuer's 2023 rights issue and 2024 reverse
split. Six render with a quantity and **no money lines at all** — a shape `parseOpPaste` treated as
malformed, so it refused them.

- `MERKINTÄ` subscribes new shares for cash → `BUY`.
- `VAIHTO - JÄTTÖ` carries the count a reverse split *results in* (1 000 shares became 10) → `SPLIT`,
  whose quantity is defined as the resulting total: `positionsAt` replaces the position and
  `buildLots` rescales the cost lots, so basis survives. Its `VAIHTO - OTTO` twin states the
  pre-split count and is ignored — booking both would apply the split twice.
- `YHDISTELY - OTTO` / `- JÄTTÖ` move shares between two lines of the same company (interim shares
  becoming ordinary) → a transfer pair.
- `IRROTUS - JÄTTÖ` and `MERKINTÄOIK. OTTO` are subscription rights arriving and being used up →
  ignored; no cash, no lasting position, and no ISIN in the paste to attach them to.

Verified end to end against a real sequence: shares held, more subscribed through a rights issue,
consolidated onto the ordinary line, reverse split at 1:100, then the remainder sold — the position
reaches zero with no oversell. Refusing these rows would have left the pre-split count on the books
and made the final sale an unmatched disposal.

**Resolved (2026-08-28): cost follows the shares.** OP's paste has no acquisition-value column, so a
`YHDISTELY` transfer-in states an amount of zero — and cost derived from zero would price the
arriving holding at nothing and report its whole value as gain. `buildLots` now carries the basis a
`TRANSFER_OUT` releases to the `TRANSFER_IN` that receives the same shares on the same date, which is
what a swap means: the shares change form, not value. A transfer-in that states its own cost
(Nordnet's `Hankinta-arvo`, C4) keeps that figure; one with no matching transfer-out still gets
nothing invented.

The two legs share a trade date and brokers disagree on which they print first — OP lists the
arriving leg above the departing one, Nordnet the reverse — so `chronological` now orders
`TRANSFER_OUT` before `TRANSFER_IN` within a date, and leaves every other pair's order alone.

Verified against a real rights-issue-then-reverse-split sequence: cost basis at the final sale is
the sum of both purchases rather than only the first, and the position closes at zero.

### C6. An instrument may have no ISIN

Registering a holding required an ISIN, and two real holdings have none to give: a share delisted
before it was ever imported, and the temporary line a rights issue created and dissolved three weeks
later. No free source maps a name or ticker back to an ISIN
(OpenFIGI omits it deliberately — FIGI exists as the unlicensed alternative; Yahoo never exposes it),
so the form could not be completed at all without inventing one.

`instruments.isin` is now nullable, and optional in the API and the form when the price source is
`manual` — nothing can price such a holding anyway. An ISIN-less instrument is matched by name, which
is already how every row of OP's ISIN-less paste resolves, and its name is required to be unique for
that reason. Every real ISIN still maps to exactly one instrument: SQLite treats NULLs as distinct,
so the unique index is unaffected.

**Migration note.** Relaxing a column constraint in SQLite means rebuilding the table, and dropping
the old one fires the children's `ON DELETE CASCADE`. drizzle-kit guards its generated SQL with
`PRAGMA foreign_keys=OFF`, which SQLite ignores inside a transaction — and the migrator runs every
migration in one, so the migration failed at COMMIT with the transactions still attached. `migrate()`
now sets that pragma on the connection before the transaction begins and restores it afterwards.
Verified on a copy of a real 336-transaction, 16 427-price database: every row survived, with no
foreign-key violations.

Also fixed: the header matcher required a tenth line, `Toiminnot`, and a real paste ended at
`Yhteensä` — whether that column is included depends on how much of the table the selection covered.
It is now optional.

### C7. Account type is missing from the model, and an osakesäästötili is not an ordinary account

The data model knows a `broker` and nothing else about an account. There is no notion that an
**arvo-osuustili** (AOT, an ordinary book-entry account) and an **osakesäästötili** (OST, the
Finnish equity savings account) are different kinds of thing. C4 mentions "OST." only while
explaining Nordnet's transaction labels; nothing in §4, §7 or §10 carries the distinction.

That is a gap in the model rather than a missing feature, and it lands hardest on phase 4:

- **The tax treatment is not the same, and not a variation on the same.** Inside an OST, trades and
  dividends are not taxed at all. Tax falls only when money is withdrawn, and only on the gain
  proportion of the withdrawal. The `PÄÄOMATULOVERO OST` rows C4 maps to `FEE` are exactly that
  event. A tax report that treated an OST disposal like an AOT disposal would produce a confident,
  wrong figure — the same failure shape as every other defect this amendment series records.
- **FIFO cost basis per disposal is the wrong question inside an OST.** What matters is the
  account's total contributions against its total value at the moment of withdrawal, so
  `core/costbasis.ts`'s per-lot machinery answers something the tax rules never ask.
- **An OST has a lifetime deposit cap** (50 000 € at the time of writing). Nothing in the model
  could represent, track or warn about it.
- **`hankintameno-olettama` does not apply** to an OST withdrawal, though §11 already defers the
  question of how it applies at all.

**Blocked on a prerequisite.** These accounts cannot be reasoned about separately until they are
*stored* separately, and today they are not: C4 records that the importer ignores Nordnet's
`Salkku` column, so an export covering both accounts files every row under whichever account the
user picked. A real import merged an AOT and an OST into one portfolio.

**What that merge cost, measured.** The app's figures were compared against both brokers' own
reported percentages. For the broker whose accounts were *not* merged, the app reproduced its
figure to the cent — meaningful evidence that its import, cost basis included, is correct. For the
broker whose two accounts had been merged into one, no definition the app computes could reproduce
its figure at all, and the merge is the most likely reason: the broker reports per account, the app
held both in one.

The two brokers also demonstrably do not mean the same thing by "tuotto-%" — one is unrealised
return on the cost of current holdings, the other is not — so no single combined figure derived
from both percentages means anything.

**Not decided here.** How account type should be represented (a column on `accounts`, a separate
table, or inferred from the broker's own account number), whether the importer should create
accounts per `Salkku` or refuse a multi-account file, and how an OST's withdrawal-time tax is
computed, all belong to the phase that builds tax reporting — designed against vero.fi at that
time, per §11, rather than guessed at now.

### C8. Vision import is dropped from phase 2

§5.2 specified two ways into a snapshot: a PDF's text layer, and a vision model for anything
without one. Only the first is built, and the second is not planned.

The owner's statements have a real text layer, so `pdf-text.ts` reads them with `node:zlib` and no
dependency. Vision existed for the scanned-document case, which has not appeared; building it would
add a Claude API key, a per-image cost and a model's transcription as a source of holdings data,
for a case nobody has.

The snapshot path is unaffected by the decision — that design was always the point. A statement
produces a snapshot, never transactions, so any future source (a photo, a bank's CSV, a
hand-typed table) plugs into the same reconciliation and the same "the user resolves every row"
rule. `snapshots.source` keeps its `vision` member; it costs nothing and re-opening the door needs
no migration.

Phase 2 is therefore: reconciliation (§5.4), PDF import (§5.2's first half), manual entry. That
leaves phase 3's AI chat as the first feature needing an API key at all.

### C9. The PDF path is dropped too; holdings arrive as an export or a paste

C8 dropped vision import. This drops the other half of §5.2: PDFs are not read at all.

Both were built and both worked. OP's year-end statement parsed correctly from its text layer, and
Nordnet's needed a font decoder — its text is drawn as two-byte glyph codes into embedded subset
fonts, decodable only through each font's `ToUnicode` map, with fonts embedded per page. That
decoder was written and verified against two real statements.

It was still the wrong source. A year-end PDF is a document you get once a year, describing a date
months in the past, and reading one costs a font engine to maintain. The brokers already publish
what reconciliation actually wants, as of today:

- **Nordnet** exports a holdings CSV. Tab-separated, UTF-16LE with a byte-order mark — the same
  encoding as its transaction export (A2).
- **OP** exports nothing, but its holdings view copies as text: one value per line, in sections
  (`Osakkeet`, `Rahasto-osuudet`), with column labels that wrap across lines.

Two parsers, chosen by whether the input has tabs. A CSV's columns are matched by heading rather
than position, for the reason A2 established: a broker is free to reorder its columns, and a
positional read files a market value as a quantity without complaining. A pasted table has no
columns, so rows are found by shape — a name followed by exactly the eight figures the table
prints — and a row with a different count is reported rather than absorbed, because counting
positions would file the next holding's name as this one's market value.

Removed with it: `pdf-text.ts`, `op-pdf.ts`, their fixtures and the upload screen. One fix from
that work is worth remembering even though its code is gone: `TextDecoder("latin1")` is an alias
for windows-1252 in the WHATWG standard, so bytes 0x80-0x9F are rewritten into typographic
characters. Harmless for prose, silently destructive for binary data read as text.

## 10d. Amendment — 2026-08-29, chat as built (phase 3)

Section 8 is implemented. Four things differ from what it describes, each for a reason worth
recording.

### D1. Sonnet, not Opus

`CHAT_MODEL` is `claude-sonnet-5`. The questions this assistant answers are a few tool calls and a
short summary of what came back — the model does no reasoning about money, because it is forbidden
from doing any arithmetic at all. Opus buys nothing here and costs several times as much per turn
on a feature meant to cost cents. Adaptive thinking is on, as designed.

### D2. Tool set

Built: `get_holdings`, `get_allocation`, `get_returns`, `get_value_series`, `get_transactions`,
`get_instruments`. Not built: `get_dividends` (dividends are already visible in
`get_transactions`, and a second view of the same rows is another chance for the two to disagree)
and `get_instrument` singular, replaced by the plural — the registry is small enough to return
whole, and a lookup-by-id tool would have the model guessing ids.

`get_instruments` returns only instruments the caller's own transactions reference. The registry
table is shared across the household by design (one ISIN, one row), so listing it whole would name
funds only another member owns.

### D3. Streaming is per event, not per token

The turn is not token-streamed to the browser. `toolRunner` runs non-streaming and the route emits
Server-Sent Events at turn granularity: which conversation this is, each tool as it is dispatched,
then the answer. The user sees "Haettu: omistukset, tuotto" while the loop runs rather than a
blank screen, which is what the progress feedback was for; token streaming would add an SSE
translation layer over `BetaMessageStream` for the remaining few seconds of a short answer.
`max_tokens` is 4096, well inside the non-streaming request budget.

The question is written to the database before the model runs, so a turn that fails leaves the
thread showing what was asked. A failed turn sends one generic error event; the cause is logged
server-side only, since an SDK error can carry request detail.

### D4. Tool call records, not transcripts of results

`chat_messages` stores each turn's text and the *names* of the tools that ran, never their
results. A stored result would outlive the ledger it came from and could be shown next to figures
that have since changed. Rerunning the tools is cheap; being wrong is not.

## 10e. Amendment -- 2026-08-29, cash and account type as built

C2 and C7 are implemented. The decisions each left open were made by the owner on 2026-08-29 and
are recorded here as settled.

### E1. Cash counts toward value and allocation, never toward returns

Portfolio value is now positions plus uninvested cash, and cash takes its own slice in every
allocation dimension. TWR and XIRR stay exactly as §7 defines them: positions only.

The reasoning is that the two numbers answer different questions. "What is my portfolio worth"
must include a deposit that has not been spent yet, or it understates what the owner has. "How did
my investments perform" must not, or an account sitting on cash reads as one whose holdings did
badly. `/api/returns` therefore returns `valueEur` (positions), `cashEur`, and
`valueWithCashEur` separately, and the dashboard shows the split rather than a single figure whose
composition has to be guessed. Every one of those is computed server-side: the browser does no
money arithmetic.

Interest already exists as a transaction type (`INTEREST`) and flows through cash like any other
row; the phase 4 tax treatment of it is still open.

### E2. Cash is derived, not stored

`core/cash.ts` sums the ledger per account and currency. There is no `cash_balances` table: every
transaction already moves cash by its own `amount`, so a table would be a second copy of the same
fact, free to drift from the rows it summarises.

Three rules the implementation makes explicit:

- **An account that records no cash at all is skipped entirely.** OP's export lists securities
  transactions and never the money that funded them, so summing its rows yields the negative of
  everything ever bought. `accountsMissingCashRecord` already identifies those accounts for the
  money-weighted return, and the same judgement applies here. The filter lives inside
  `cashBalancesAt`, not at each call site, because a caller who forgot would present a five-figure
  negative balance as fact.
- **A balance with no fx rate for the day is `null`, not zero** -- the same rule §7 applies to an
  unpriceable holding.
- **A negative balance is reported but never allocated.** An overdraft is not an asset; letting it
  subtract from a bucket would make every other weight a share of a total that does not exist.

### E3. Account type is a column the owner sets

`accounts.account_type` is `'aot' | 'ost' | 'other'`, nullable. Null means nobody has classified
the account, is displayed as "Ei valittu", and is never defaulted to the ordinary case: inside an
OST nothing is taxed until withdrawal, so phase 4 must refuse to report on an unclassified account
rather than assume. Not inferred from the broker's own numbering, which would be wrong silently
the moment a broker changed it. Editable after the fact, unlike broker and base currency, because
no stored transaction has been interpreted under it yet.

### E4. A multi-account export is refused, not split

The importer reads Nordnet's `Salkku` column and refuses a file naming more than one account,
listing them. The owner exports per account instead. This replaces the old behaviour of ignoring
the column, which filed every row under whichever account was selected -- the merge C7 measured.

## 10f. Amendment -- 2026-08-29, bank accounts, cash and spending

The spec described a portfolio manager. The owner asked for the rest of the household's money as
well, and this records what that turned into, since §4's data model and §7's definitions both
changed.

### F1. Two kinds of account, not one

`accounts.kind` is `brokerage` or `bank`, and each kind carries its own types: a brokerage account
is an arvo-osuustili or osakesäästötili, a bank account is current, savings or fixed-term. The two
sets never mix, and a mismatch is refused rather than corrected -- "a savings account that is an
osakesäästötili" is not a typo with an obvious fix.

The distinction is the owner's to make, never the importer's: a bank statement looks identical
whether the account behind it is a current account or a savings account.

### F2. Bank movements never reach the return figures

`DEPOSIT` and `WITHDRAWAL` feed XIRR as external cash flows, so a grocery payment among them reads
as capital pulled out of the portfolio. `loadPortfolio` returns `investedTxns` beside `txns`, and
every return path -- value series, both cash-flow definitions, the opening valuation, and the
chat's own tools -- reads the invested subset. Money genuinely moving from a bank account to a
broker still counts, because the broker's own export records that arrival.

### F3. Statement import, and why the PDF path returned

§10c/C9 dropped the PDF path. It is back, and for a reason that did not exist then: a statement
prints its own opening and closing balance, so the import can check its own work. Parsed rows plus
the opening balance must equal the printed closing balance, or the file is refused and the
difference named. A mis-parsed layout cannot pass silently, which is what makes reading a layout
acceptable at all. The CSV path has no such guard, which is why it needs the balance typed in by
hand.

Two banks, two parsers, no shared configuration: OP writes Finnish with a unicode minus and a space
for thousands; SweepBank writes English, where a comma groups thousands and a dot separates cents.
Rows are identified by the bank's archive id, which is stable across OP's own two formats, so the
same period may be imported twice -- the PDF fills in payees the CSV leaves blank.

### F4. Cash: counted, but not everywhere

Cash counts toward portfolio value and allocation, and never toward TWR or XIRR. Balances are
derived per account and currency from the ledger rather than stored, since every row already moves
cash by its own amount. Three rules the implementation makes explicit:

- An account that records no cash at all is skipped entirely -- OP's securities export lists
  securities only, so summing it yields the negative of everything ever bought.
- A balance with no fx rate for the day is `null`, not zero.
- A fixed-term deposit is reported as locked until its maturity date, and gets its own allocation
  slice: it behaves like a short bond, not like money in a current account. A deposit whose terms
  nobody recorded stays locked.

### F5. Internal transfers are matched structurally

Money the owner moves between their own accounts is neither income nor spending, and text cannot
identify it: a transfer to a savings account carries the owner's own name, and an assistant-written
rule on that name once turned moved savings into income. An outgoing row is matched against an
incoming one on another owned account, same amount, within five days, each row used once. A
transfer whose other half is not in the ledger stays income or spending, because that is what it is
from the ledger's point of view.

A payment that funded a securities purchase is matched separately, against the purchase itself, on
brokers that record no cash -- a regular fund saving leaves the bank as a payment and arrives as a
BUY, so both halves are negative and the opposite-sign matching cannot see them.

### F6. Spending categories live in the database

Rules are `(pattern, category, source)` rows per user, seeded from a built-in Finnish merchant list
on first use and owned by the user afterwards. The longest matching pattern wins, so the answer does
not depend on insertion order. `source` records who decided -- `seed`, `ai` or `user` -- because a
rule the model guessed is a weaker claim than one a person made.

Each bank import puts the payees no rule recognises to the model once, in one batch. Every proposal
is validated before storage: the category must exist, the pattern must occur in a payee that import
actually contained, and a rule already stored is never replaced. Failure never fails the import.

### F7. §8's ban on arithmetic is relaxed, with a calculator

§8 required that every figure come from a tool and that the model perform no arithmetic in prose.
The owner asked for derived figures. The rule now is that base figures still come from tools, and
anything derived goes through a `calculate` tool doing exact integer-hundredth arithmetic -- so the
model chooses what to compute without doing the computing. Derived figures must be named as such.

### F8. Still open

- **Debt as an account.** A loan repayment is one spending category today. Principal reduces a debt
  and only interest is a cost, but a statement line does not separate them. Modelling a loan as an
  account with a negative balance would let net worth include what is owed; not built.
- **Income beyond the bank.** Only bank rows are read as income; a salary paid to an account this
  app does not know is invisible to the flow diagram.

## 10g. Amendment -- 2026-08-29, corrections found while designing phase 4

Phase 4 is specified in its own document,
[2026-08-29-tax-module-design.md](2026-08-29-tax-module-design.md). Designing it against vero.fi,
as §11 required, turned up two errors here.

### G1. The OST deposit cap is 100 000 €, not 50 000 €

C7 records "a lifetime deposit cap (50 000 € at the time of writing)". It is 100 000 €. C7's
substantive point -- that an OST is not a variation on an ordinary account and cannot be taxed like
one -- stands unchanged. The lesson is the one C7 itself is about: a figure with no citation cannot
be re-checked, so every tax constant now carries the page it came from and the date it was read.

### G2. FIFO is per account, and `buildLots` pooled across accounts

vero.fi states the matching rule as FIFO "within one account". `buildLots` keyed its open lots by
`instrumentId` alone -- `accountId` appeared nowhere in the file -- so lots pooled across accounts.
That is a different rule, and it agrees with the real one only while an instrument is held in a
single account, which is true of the current ledger and is why nothing ever looked wrong.

This is the defect C7 predicted, arriving from the direction it did not: C7 worried about two
accounts *merged by the importer*, and the accounts here were stored correctly all along. The
pooling was in the cost-basis engine.

Fixed in phase 4: lots and disposals carry their account. `costBasisAt` and
`costBasisPerInstrument` still aggregate per instrument, so the holdings view is unchanged -- a
position spans accounts even though tax does not.

## 11. Open questions

- Whether Nordnet's transaction export reaches back to account opening or only a recent window.
  Resolved either way by the opening-position flow (§4.3), so it does not block phase 1.
- ~~Whether `nordnet_fund` NAV access needs an authenticated session.~~ **Resolved by A5:** the
  historical-prices endpoint does; the fund detail page (what `nordnet_fund` actually uses) does not.
- ~~Exact Finnish tax rules (FIFO vs. hankintameno-olettama, the 30%/34% bracket boundary,
  85%-taxable listed dividends) are deliberately deferred to the phase 4 spec and must be
  verified against vero.fi at that time rather than assumed.~~ **Resolved by the phase 4 spec §3**,
  where every rule is cited to vero.fi -- except the bracket boundary, which is now out of scope
  rather than unresolved: the tax module reports taxable income, never tax owed.

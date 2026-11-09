# PromptFolio

A self-hosted portfolio and money tracker for a household using Finnish banks and brokers. The
app is in English; it imports Finnish banks' and brokers' exports, which stay Finnish. It keeps an append-only ledger
of brokerage transactions and bank statements, values holdings in euros, and answers four questions
from data you control: what the portfolio is worth, how it has performed, where the money went, and
how far it has drifted from where you wanted it.

It also computes your Finnish capital-gains figures independently, so the pre-filled tax return has
something to be checked against.

One Cloudflare Worker serves the whole app and one D1 (SQLite) database holds everything. No message
queue, nothing else to run — Cron Triggers run the price refresh.

---

## What it does

| Screen        | What it shows                                                                                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Dashboard** | Portfolio value, time- and money-weighted return, allocation, value over time                                                                                      |
| **Holdings**  | Every holding: quantity, cost basis, market value, gain, weight, price staleness                                                                                   |
| **Reconcile** | A broker's holdings statement compared against what the ledger derives for the same day                                                                            |
| **Cash**      | Bank accounts, balances per currency, statement import, manual entries                                                                                             |
| **Spending**  | Spending by category or payee, a Sankey of the year's money, monthly income against spending, category by month, and every transaction with the class it was given |
| **Tax**       | Per tax year: realised gains both permitted ways, dividends, OST withdrawals                                                                                       |
| **Rebalance** | Target allocation, drift against it, where to put new money, and fees per year                                                                                     |
| **Chat**      | A chat assistant that answers from the same figures the screens show                                                                                               |
| **Imports**   | Import history, with undo                                                                                                                                          |

Every chart is interactive: hover for a crosshair and exact figures, drag across the value chart to
zoom to any period, and pick a preset window. Colours come from one palette checked for
colour-vision separation and contrast against both the light and dark background, so a series keeps
its colour when a filter changes which series are shown.

Two kinds of account, kept apart deliberately:

- **Brokerage** — book-entry securities account, equity savings account (OST). Holds instruments; drives the return figures.
- **Bank** — current, savings, fixed-term deposit, credit card. Holds cash; never touches the
  return figures. A credit card is the exception that holds none: its balance is what you owe, so
  it is excluded from cash and from reconciliation.

## Requirements

- **Node 26+ and pnpm 11+**.
- **A Cloudflare account** for the deployed instance. Local development needs none: the Worker
  and its D1 database run on your machine.

## First run

### Locally

```bash
pnpm install
cp .env.example .env
echo "BETTER_AUTH_SECRET=$(node -e "console.log(crypto.randomUUID()+crypto.randomUUID())")" >> .env
pnpm run dev
```

`pnpm run dev` applies every migration to a local D1 under `.wrangler/state` before serving, and
`pnpm run preview` does the same for the production build. The assistant needs `ANTHROPIC_API_KEY` in
`.env`; without it every other screen still works. Setting `AI_GATEWAY_ID` (and `AI_GATEWAY_TOKEN`
for an authenticated gateway) routes Claude calls through Cloudflare AI Gateway, which needs
`pnpm exec wrangler login` once. Migrations are additive and idempotent, so re-running them against
a current database is a no-op.

### On Cloudflare

```bash
pnpm exec wrangler d1 create promptfolio        # paste the id into wrangler.jsonc
pnpm exec wrangler secret put BETTER_AUTH_SECRET
pnpm run deploy
```

`pnpm run deploy` migrates the remote database before uploading the Worker, so a schema change
never ships without its table. `BASE_URL` and `ALLOW_SIGNUP` are set in `wrangler.jsonc`; every
other variable below is a secret, set with `wrangler secret put`.

### Creating your account

This is a closed instance with no public sign-up. On a fresh database the login page shows a
**create-account** form; fill it in once and you are signed in. The form disappears the moment an
account exists, and the server refuses a second use of it even if someone finds the URL — so there
is no window after your first visit in which a stranger could claim the instance. The one real
risk is racing your own first visit: don't expose a fresh instance to the network before opening
it yourself.

To add a family member later, open the gate briefly:

```bash
# .env: ALLOW_SIGNUP=true, then restart
curl -s localhost:3000/api/auth/sign-up/email \
  -H 'content-type: application/json' \
  -d '{"name":"Family Member","email":"them@example.com","password":"a strong passphrase"}'
# .env: ALLOW_SIGNUP=false (the default), then restart
```

## Configuration

| Variable             | Default                     | Purpose                                                                                                                                                          |
| -------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET` | _(none — refuses to serve)_ | Session signing key, ≥32 characters. No fallback and no usable example value: a default secret in a self-hosted financial app is a silent authentication bypass. |
| `BASE_URL`           | `http://localhost:3000`     | Where the app is reached                                                                                                                                         |
| `ALLOW_SIGNUP`       | `false`                     | Opens `POST /api/auth/sign-up/email`. Read once at boot.                                                                                                         |
| `CRON_SECRET`        | _(none)_                    | Authorises a hand-run `POST /api/cron/refresh`. Empty refuses every call.                                                                                        |
| `ANTHROPIC_API_KEY`  | _(none)_                    | Claude API key for the assistant, the PDF reader, the payee classifier and price-page lookups. Chat answers 503 without it.                                      |
| `AI_GATEWAY_ID`      | _(none)_                    | Optional Cloudflare AI Gateway name; when set, every Claude call goes through it. `AI_GATEWAY_TOKEN` is the token for an authenticated gateway.                  |

## Getting data in

Every figure is derived from imported transactions. Nothing is fetched from a live brokerage
connection, and nothing is inferred that the data does not say.

### Brokerage

**Nordnet** — export transactions as CSV (Mina sidor → Transaktioner) and upload on **Imports**.
The format is detected by its header (UTF-16LE, tab-delimited). A file covering more than one
`Salkku` is **refused**, naming the accounts: importing two accounts as one made a real
portfolio's returns unreproducible, so export per account.

A trade's price and its cash can be in different currencies: a US share bought through a Finnish
broker is quoted in USD and paid for in EUR. The importer reads both, so the instrument resolves to
its own listing rather than a European one that happens to quote the same ISIN.

**OP** — OP has no securities CSV. Copy the web transaction table and paste it into the OP box on
**Imports**. Pages can be pasted in any order, but a sale whose purchase is on a page you have not
imported yet shows an unknown cost basis (_unknown_) until that page arrives.

Two Nordnet label pairs stay **unmapped** on purpose and surface for review rather than being
booked: `VAIHTO AP-OTTO`/`VAIHTO AP-JÄTTÖ` (a share-class swap, whose correct cost basis depends
on a tax judgement a CSV row cannot answer) and `DESIM. ULOSKIRJ. KÄT`/`DESIM KIRJAUS OTTO` (a
fractional-share cash-out).

### Bank statements

Upload on **Cash**, in either format:

- **CSV** (OP's transaction export) — fast, but its payee column is sometimes empty.
- **PDF** (any bank's statement) — **preferred**, because it carries the opening and closing
  balances. A model is asked once to describe the layout of a statement it has not seen before —
  where the dates, amounts and balances sit — and that description is remembered for you, so the
  same bank's next statement is read without asking anything. The import checks its own work
  against the printed balances: parsed rows plus the opening balance must equal the printed
  closing balance. When they don't, the difference is named and you still get the draft to
  correct; only committing a draft that doesn't add up is refused. A PDF also brings the payer's
  message, and a fixed-term deposit's maturity date.

Both formats identify rows by the bank's archive id, so re-importing an overlapping period skips
what is already stored. Importing the same period in _both_ formats is useful: the PDF fills in
payees the CSV left blank, without duplicating anything.

**Credit cards.** OP's card log is a third format, detected by its own header, and it changes what
a bill means. Without it, the lump sum leaving your current account each month is all the ledger
knows, and it lands in the loans category (_Loans and credit_) — a large line that says nothing about what you bought.
Import the card log and the bill is recognised as what it is: money moved to the card, cancelled
against the card's own settlement row, with the individual purchases taking its place in the
categories. The card's own charges — interest, an account fee — are ordinary spending, and a refund
offsets the category it belongs to.

For an account no bank exports (or one whose statements you don't have), enter deposits,
withdrawals and interest by hand on **Cash**.

### The balance before your statements begin

A statement reaches back a year or two, not to the account's opening. Enter today's balance under
**Reconcile balance** and the app writes the opening balance that makes the ledger agree with it. A
PDF import does this by itself, from the balance the statement states.

Re-running it later is a **check**: a difference of zero means every imported row still adds up to
what the bank says.

## How the numbers are defined

The point of this app is that a figure means exactly one thing. The definitions that are easy to
get wrong:

- **Money is integers.** Amounts are minor units (`bigint`), quantities scale by 10⁶, FX by 10⁸.
  Decimal strings on the wire, never JSON floats. The assistant gets a calculator tool rather than
  doing arithmetic in prose.
- **Cost basis is FIFO within one account**, which is the rule Finnish tax states. The same share
  held in two accounts has two independent queues; a position's total still spans accounts, because
  a position is not an account.
- **A swap carries its lots.** When a holding changes form — a fund merger, a tender offer — the
  original lots travel with it, each keeping its own acquisition date and cost, rather than merging
  into one lot dated the swap. Both matter: the date sets the deemed-cost percentage, and the
  per-lot cost is what FIFO consumes on a later partial sale.
- **Returns measure invested capital.** TWR and XIRR see brokerage transactions only. A bank
  account's salary and groceries never enter them — otherwise a month of shopping would read as
  portfolio underperformance.
- **Cash counts toward value and allocation, never toward returns.** `/api/returns` reports
  `valueEur` (positions), `cashEur` and `valueWithCashEur` separately.
- **A fixed-term deposit is not spendable cash.** It counts toward total value, gets its own
  allocation slice, and is reported as locked until its maturity date. A deposit whose terms nobody
  recorded stays locked: "we don't know when this frees up" is not "you can spend it".
- **Transfers between your own accounts are neither income nor spending.** They are matched
  structurally — an outflow against an inflow on another of your accounts, same amount, within five
  days — because text cannot do it: a transfer to your own savings carries your own name. A
  transfer whose other half is not in the ledger stays income or spending, because that is what it
  is from the ledger's point of view.
- **A payment that funded a fund purchase is investing, not spending.** Matched against the
  purchase it paid for, on brokers that record no cash of their own.
- **An unpriceable holding is excluded and named**, never valued at zero. A holding with no price
  at all shows _no price_.
- **"Old" means older than a price that could exist**, not "not dated today". Markets close, and a
  fund's NAV publishes a weekday behind, so on a Saturday a share's Friday close is current and a
  fund's Thursday NAV is too. Only a price older than that shows _stale_, with its date. A gap in
  a price feed with bars on both sides is read as a market holiday rather than a missing price.
- **Spending totals exclude what is not spending**: opening balances, investment funding, internal
  transfers, and the lump sum that settles a credit card. One definition serves every view — the
  category list, the payee list, the Sankey, the monthly totals and the assistant's tools — because
  two views of the same month disagreeing is worse than either being wrong alone.

## The assistant

Ask questions in English on **Chat**. Answers are written in Markdown and rendered as such —
lists, tables of figures, headings and emphasis. The renderer builds React elements and never an
HTML string, because an answer can quote a payee's own text, and that text came out of an imported
statement rather than from this app. It reads through the same functions the screens call, so
chat and dashboard cannot disagree. **No tool writes to the ledger** — not a transaction, not an
account, not a price. Three tools do write, and what they write is the classification: you can ask
it to sort the payees no rule recognises, correct a category that came out wrong, or drop a rule
that matches too much.

Three guards make that safe to give away. A new rule must name a category the app already has, and
its pattern must occur in a payee your own ledger holds and no rule yet matches — a payee invented
by the model, or planted in a statement's text, writes nothing. A rule **you** wrote is never
touched: the assistant may revise a built-in rule or its own, and is told to say so when it can't.
Every rule it stores is marked `ai` on **Spending**, where you can edit or delete it. A wrong rule
misreads a total; it cannot alter a euro of what was imported.

Base figures always come from a tool. The model may derive new ones (differences, shares,
monthly rates) but is told to use the calculator rather than mental arithmetic, and to say when a
figure is derived. It gives no investment advice and makes no forecasts.

**Classification.** Each bank import puts the payees no rule recognises to the model once, in one
batch, and stores what it proposes as rules. Every proposal is checked first: the category must
exist, the pattern must occur in a payee the import actually contained, and a rule already stored
is never replaced. Each rule records who decided — `seed`, `ai`, or `user` — and you can edit or
delete any of them on **Spending**.

Both run on the Claude API (models listed in `src/server/chat/models.ts`), through
[Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/) when `AI_GATEWAY_ID` is set
and straight to Anthropic otherwise. Usage is billed to your Anthropic account, and the figures a
question needs are sent to Anthropic.

## Tax figures

**Tax** reports one tax year at a time, computed from the ledger rather than taken from anyone's
statement. Finnish brokers already report to Verohallinto, so the return arrives pre-filled: the
point of a second, independent derivation is disagreement, and every figure shows its workings so a
difference can be traced rather than argued about.

Every rule is cited to vero.fi in `src/core/tax/rates.ts` and was verified on 2026-08-29. What the
report knows:

- **Realised gains, both permitted ways.** Actual cost against the deemed acquisition cost (_hankintameno-olettama_, 20 % of
  the sale price under ten years' ownership, 40 % from ten), with the better one marked and the
  other shown beside it — the choice is the taxpayer's, so it is displayed rather than assumed. The
  two methods use different bases: the actual method deducts the selling fee, the deemed one does
  not, so the deemed cost is a share of the **gross** sale price.
- **FIFO within one account**, which is the rule vero.fi states. A share held in two accounts has
  two independent queues.
- **The small-sales exemption**, both ways: at most 1 000 € of sales in a year makes the gains
  exempt _and_ the losses non-deductible.
- **Losses**, netted within the year and carried five years, oldest first.
- **Dividends**: 85 % taxable, 15 % exempt.
- **Equity savings accounts.** Nothing inside an OST is taxed when it happens — not a sale, not a
  dividend. Tax falls on withdrawal, on the profit share: profit ÷ account value × amount withdrawn,
  with the account valued _immediately before_ the withdrawal. The capital part of a withdrawal
  reduces the deposits, which is both the base for the next withdrawal and what the 100 000 €
  lifetime cap is measured against.
- **What counts as a withdrawal, and what doesn't.** The tax the broker withholds is booked as its
  own row but is part of the withdrawal, so it counts toward the amount withdrawn and is shown
  beside our own figure to compare against. A share subscription's _reservation_ — money taken out
  to pay for it and returned days later, with the allotment booked separately as the purchase — is
  not a withdrawal at all, and is matched structurally, since nothing in the export marks it.
- **A swap carries its lots.** When a holding changes form (a fund merger, a tender offer), the
  original lots travel with it — each keeping its own acquisition date and cost — rather than
  merging into one lot dated the swap. Both matter: the date sets the deemed-cost percentage, and
  the per-lot cost is what FIFO consumes on a later partial sale.

A withdrawal whose account holds something unpriceable — an unlisted share, or a delisted one with
no surviving feed — reports _cannot be calculated_ naming the instrument and date, never an
apportionment resting on a guessed value. The row itself offers to record that price, because the
blocking holding has usually been sold since and appears on no other screen. Every later withdrawal
reads as not computable too: the earlier gap leaves the deposits too high by an unknown amount, so
the account would look like it holds no profit — and a zero that is really an unknown is the one
failure this whole report exists to avoid.

## Targets, drift and fees

**Rebalance** answers the third question this app exists for: where have I drifted, and what am I
paying?

You set a target allocation on one dimension — by kind, currency, account or instrument — as
percentages that must sum to exactly 100 %. A set that sums to 90 % is refused rather than scaled
up: it means a slice was forgotten, and inventing the missing tenth would have you measuring drift
against a target you never set. A slice with no target is _untargeted_, which is not the same as
targeted at zero — only the second implies selling it.

Drift is shown in percentage points and in euros, and a slice within five points of its target reads
_on target_. The figure is always computed; the band only decides how it reads, because a screen
that calls everything drifted teaches you to ignore it.

**Two ways to correct it, and they are not equal.**

- **New money** is the default. You enter an amount and the app says where it should go, measured
  against the target applied to the total _after_ the deposit — adding money changes every weight.
  This realises no gain and triggers no tax.
- **Full rebalance** is a view you ask for. It shows the buys and sells that hit the target exactly,
  and **every sale states the gain it would realise**, because a tool that says "sell 4 000 €"
  without saying what that realises is quietly recommending a taxable event. The figure is a gain,
  never a tax — the tax depends on capital income this app cannot see. Trades under 50 € are dropped
  and listed, since a broker's minimum commission would cost more than the drift they correct.

**Fees** are reported per year: commission paid on trades, the broker's own charges, and both
together. **Capital income tax withheld on an equity savings account is excluded and shown in its
own column.** The broker books it as a fee row, for a good reason, but it is tax on a gain rather
than a cost of investing — and in a real ledger it is most of the fee total in the years it appears,
so counting it would make the figure meaningless.

## Prices and the nightly refresh

Cron Triggers (`wrangler.jsonc`) run **weekdays at 18:00 UTC**, after exchanges close and funds
publish: the job refreshes FX from the ECB and every non-`manual` instrument's price, then backfills
any instrument whose history does not yet reach its earliest transaction. Hourly runs fetch intraday
prices and finish paused instrument lookups. Every attempt is logged to `price_fetch_log`; a failing
source degrades that holding's badge to stale rather than breaking the dashboard.

**Price sources.** Each instrument has one: **Yahoo** (listed shares, ETFs), a **price page**, or
**manual**. For a page, a model finds it by web search and writes a recipe (a regular expression);
the app verifies the recipe against the page (the fund's identifier must sit next to the price)
before saving it, and from then on reads the page without the model.

**Which holdings get real history.** Yahoo answers a date range, so Yahoo-priced instruments
backfill years of real prices. **Price pages do not**: they expose only today's value, so their
history accumulates one point per evening from your first deployment. Cost basis and current value
are right from day one; only the historical curve for those instruments is short.

To run it by hand:

```bash
curl -fsS -X POST -H "authorization: Bearer $CRON_SECRET" https://your-worker.workers.dev/api/cron/refresh
```

## Backup and restore

Everything is one D1 database.

```bash
pnpm exec wrangler d1 export promptfolio --remote --output backup-$(date +%F).sql
```

Restore into an empty database with `wrangler d1 execute promptfolio --remote --file <backup>`.

## Development

```bash
pnpm run dev         # hot-reloading server on :3000
pnpm run check       # lint, format check, typecheck, tests with coverage
pnpm run e2e         # the browser test, against its own database
pnpm run db:generate # a migration from a schema change
```

`pnpm run check` is the gate: oxlint (including vendored `anti-slop` rules), oxfmt, `tsc --noEmit`,
and the test suite with an 80 % per-file coverage floor. No test may touch the network — a preload
replaces `fetch` with one that throws, so every external call is injected and stubbed.

```
src/core/      pure domain: money, ledger, cost basis, returns, allocation, cash,
               staleness, tax/, rebalance/
src/server/    HTTP routes, D1 access, importers, price sources, chat,
               spending, tax, rebalance
src/web/       React frontend (TanStack Router, Query, Charts)
```

`src/core` never sees a database row, and `src/server/valuation.ts` is the one module that
translates between stored integers and the domain's `Money`/`Quantity`/`FxRate`.

## Limits

- **The tax report checks, it does not file.** No euro figure for tax owed (the 30 %/34 % bracket
  depends on capital income this app cannot see), no foreign dividend tax credit, no OmaVero
  export.
- **Dividend withholding is not in the ledger.** Both broker exports publish one combined
  "Kulut / Korot / Verot" column, so a dividend's stored amount is what arrived, and the taxable
  85 % is computed on that. Where the payer withheld tax, the real gross is higher — the report
  badges every such row rather than implying certainty.
- **Nothing here says whether to rebalance.** The app shows the gap and what closing it would
  realise; choosing when to act, and which lots to sell for the smallest gain, is yours. It places
  no orders and never will.
- **History for page-priced funds starts at your deployment** (above).
- **OP's securities export records no cash**, so those accounts show no balance and their
  money-weighted return is measured from purchases instead of deposits.
- **A transfer whose other half is not imported** counts as income or spending. Importing both
  accounts fixes it. A credit card bill is one of these: until the card's own log is imported, the
  bill is the only record of that money, so it is reported as spending rather than hidden.
- **Spending classification is substring rules**, not understanding. Unmatched payees land in _Other_
  and are always reported as a share, so a total is never quietly missing a third of the money.
- **A sale's realised gain is a gain, not a tax.** What tax it attracts depends on your other
  capital income, which this app cannot see, so it reports the gain and stops.
- **One D1 database.** The first-run guard assumes a single database; do not point two deployments
  at it.

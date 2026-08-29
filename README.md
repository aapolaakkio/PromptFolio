# PromptFolio

A self-hosted portfolio and money tracker for a Finnish household. It keeps an append-only ledger
of brokerage transactions and bank statements, values holdings in euros, and answers three
questions from data you control: what the portfolio is worth, how it has performed, and where the
money went.

One Bun process serves the API, the React frontend and a nightly price refresh. One SQLite file
holds everything. No external database, no message queue, nothing else to run.

---

## What it does

| Screen         | What it shows                                                                                |
| -------------- | -------------------------------------------------------------------------------------------- |
| **Yleiskuva**  | Portfolio value, time- and money-weighted return, allocation, value over time                |
| **Omistukset** | Every holding: quantity, cost basis, market value, gain, weight, price staleness             |
| **Täsmäytys**  | A broker's holdings statement compared against what the ledger derives for the same day      |
| **Käteinen**   | Bank accounts, balances per currency, statement import, manual entries                       |
| **Kulutus**    | Spending by category or payee, a Sankey of the year's money, monthly income against spending |
| **Verot**      | Per tax year: realised gains both permitted ways, dividends, OST withdrawals                  |
| **Avustaja**   | A chat assistant that answers from the same figures the screens show                         |
| **Tuonnit**    | Import history, with undo                                                                    |

Two kinds of account, kept apart deliberately:

- **Brokerage** — arvo-osuustili, osakesäästötili. Holds instruments; drives the return figures.
- **Bank** — current, savings, fixed-term deposit. Holds cash; never touches the return figures.

## Requirements

- **Docker and Docker Compose** (recommended), or
- **Bun 1.4+** directly. No Node.js: `bunfig.toml` sets `[run] bun = true`, so even `oxlint` and
  `oxfmt` — whose binaries ship a `#!/usr/bin/env node` shebang — run under Bun.

## First run

### Docker

```bash
cp .env.example .env
echo "BETTER_AUTH_SECRET=$(bun -e 'console.log(crypto.randomUUID()+crypto.randomUUID())')" >> .env
docker compose up --build -d
curl -fsS localhost:3000/api/health     # {"ok":true}
```

The container creates `/data/promptfolio.db` in the `promptfolio-data` volume and applies every
migration before serving. It does this on every boot; migrations are additive and idempotent, so
re-running them against a current database is a no-op.

### Without Docker

```bash
bun install
cp .env.example .env
echo "BETTER_AUTH_SECRET=$(bun -e 'console.log(crypto.randomUUID()+crypto.randomUUID())')" >> .env
bun run build
bun start
```

`bun start` migrates before serving, exactly as the container does.

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

| Variable             | Default                    | Purpose                                                                                                                                                              |
| -------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET` | _(none — refuses to boot)_ | Session signing key, ≥32 characters. No fallback and no usable example value: a default secret in a self-hosted financial app is a silent authentication bypass.     |
| `BASE_URL`           | `http://localhost:3000`    | Where the app is reached                                                                                                                                             |
| `DATABASE_PATH`      | `./data/promptfolio.db`    | SQLite file (the container uses `/data/promptfolio.db`)                                                                                                              |
| `PORT`               | `3000`                     | HTTP port                                                                                                                                                            |
| `ALLOW_SIGNUP`       | `false`                    | Opens `POST /api/auth/sign-up/email`. Read once at boot.                                                                                                             |
| `ANTHROPIC_API_KEY`  | _(none)_                   | Enables the assistant and the import-time classification of new payees. Without it, chat answers 503 and classification is skipped silently — everything else works. |

## Getting data in

Every figure is derived from imported transactions. Nothing is fetched from a live brokerage
connection, and nothing is inferred that the data does not say.

### Brokerage

**Nordnet** — export transactions as CSV (Mina sidor → Transaktioner) and upload on **Tuonnit**.
The format is detected by its header (UTF-16LE, tab-delimited). A file covering more than one
`Salkku` is **refused**, naming the accounts: importing two accounts as one made a real
portfolio's returns unreproducible, so export per account.

**OP** — OP has no securities CSV. Copy the web transaction table and paste it into the OP box on
**Tuonnit**. Pages can be pasted in any order, but a sale whose purchase is on a page you have not
imported yet shows an unknown cost basis (_tuntematon_) until that page arrives.

Two Nordnet label pairs stay **unmapped** on purpose and surface for review rather than being
booked: `VAIHTO AP-OTTO`/`VAIHTO AP-JÄTTÖ` (a share-class swap, whose correct cost basis depends
on a tax judgement a CSV row cannot answer) and `DESIM. ULOSKIRJ. KÄT`/`DESIM KIRJAUS OTTO` (a
fractional-share cash-out).

### Bank statements

Upload on **Käteinen**, in either format:

- **CSV** (OP's transaction export) — fast, but its payee column is sometimes empty.
- **PDF** (OP's statement, SweepBank/Ferratum's) — **preferred**, because it carries the opening
  and closing balances. The import checks its own work against them: parsed rows plus the opening
  balance must equal the printed closing balance, or the file is refused and the difference named.
  A PDF also brings the payer's message, and a fixed-term deposit's maturity date.

Both formats identify rows by the bank's archive id, so re-importing an overlapping period skips
what is already stored. Importing the same period in _both_ formats is useful: the PDF fills in
payees the CSV left blank, without duplicating anything.

For an account no bank exports (or one whose statements you don't have), enter deposits,
withdrawals and interest by hand on **Käteinen**.

### The balance before your statements begin

A statement reaches back a year or two, not to the account's opening. Enter today's balance under
**Täsmäytä saldo** and the app writes the opening balance that makes the ledger agree with it. A
PDF import does this by itself, from the balance the statement states.

Re-running it later is a **check**: a difference of zero means every imported row still adds up to
what the bank says.

## How the numbers are defined

The point of this app is that a figure means exactly one thing. The definitions that are easy to
get wrong:

- **Money is integers.** Amounts are minor units (`bigint`), quantities scale by 10⁶, FX by 10⁸.
  Decimal strings on the wire, never JSON floats. The assistant gets a calculator tool rather than
  doing arithmetic in prose.
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
- **An unpriceable holding is excluded and named**, never valued at zero. A stale price shows
  _vanha_ with its date; a holding with no price at all shows _ei hintaa_.
- **Spending totals exclude what is not spending**: opening balances, investment funding, internal
  transfers.

## The assistant

Ask questions in Finnish on **Avustaja**. It reads through the same functions the screens call, so
chat and dashboard cannot disagree. It is read-only: no tool writes to the ledger.

Tools: holdings, allocation, returns, value series, transactions, instruments, cash, spending,
uncategorised spending, the tax year, and an exact decimal calculator. Every result carries the date it was
computed for and whether any price behind it is stale.

Base figures always come from a tool. The model may derive new ones (differences, shares,
monthly rates) but is told to use the calculator rather than mental arithmetic, and to say when a
figure is derived. It gives no investment advice and makes no forecasts.

**Classification.** Each bank import puts the payees no rule recognises to the model once, in one
batch, and stores what it proposes as rules. Every proposal is checked first: the category must
exist, the pattern must occur in a payee the import actually contained, and a rule already stored
is never replaced. Each rule records who decided — `seed`, `ai`, or `user` — and you can edit or
delete any of them on **Kulutus**.

Both features cost money (cents per question or import) and send the relevant figures to
Anthropic's API. Leave `ANTHROPIC_API_KEY` unset and neither runs.

## Tax figures

**Verot** reports one tax year at a time, computed from the ledger rather than taken from anyone's
statement. Finnish brokers already report to Verohallinto, so the return arrives pre-filled: the
point of a second, independent derivation is disagreement, and every figure shows its workings so a
difference can be traced rather than argued about.

Every rule is cited to vero.fi in `src/core/tax/rates.ts` and was verified on 2026-08-29. What the
report knows:

- **Realised gains, both permitted ways.** Actual cost against the *hankintameno-olettama* (20 % of
  the sale price under ten years' ownership, 40 % from ten), with the better one marked and the
  other shown beside it — the choice is the taxpayer's, so it is displayed rather than assumed. The
  two methods use different bases: the actual method deducts the selling fee, the deemed one does
  not, so the deemed cost is a share of the **gross** sale price.
- **FIFO within one account**, which is the rule vero.fi states. A share held in two accounts has
  two independent queues.
- **The small-sales exemption**, both ways: at most 1 000 € of sales in a year makes the gains
  exempt *and* the losses non-deductible.
- **Losses**, netted within the year and carried five years, oldest first.
- **Dividends**: 85 % taxable, 15 % exempt.
- **Equity savings accounts.** Nothing inside an OST is taxed when it happens — not a sale, not a
  dividend. Tax falls on withdrawal, on the profit share: profit ÷ account value × amount withdrawn,
  with the account valued *immediately before* the withdrawal. The capital part of a withdrawal
  reduces the deposits, which is both the base for the next withdrawal and what the 100 000 €
  lifetime cap is measured against.
- **What counts as a withdrawal, and what doesn't.** The tax the broker withholds is booked as its
  own row but is part of the withdrawal, so it counts toward the amount withdrawn and is shown
  beside our own figure to compare against. A share subscription's *reservation* — money taken out
  to pay for it and returned days later, with the allotment booked separately as the purchase — is
  not a withdrawal at all, and is matched structurally, since nothing in the export marks it.
- **A swap carries its lots.** When a holding changes form (a fund merger, a tender offer), the
  original lots travel with it — each keeping its own acquisition date and cost — rather than
  merging into one lot dated the swap. Both matter: the date sets the deemed-cost percentage, and
  the per-lot cost is what FIFO consumes on a later partial sale.

A withdrawal whose account holds something unpriceable — an unlisted share, or a delisted one with
no surviving feed — reports *ei laskettavissa* naming the instrument and date, never an
apportionment resting on a guessed value. The row itself offers to record that price, because the
blocking holding has usually been sold since and appears on no other screen. Every later withdrawal
reads as not computable too: the earlier gap leaves the deposits too high by an unknown amount, so
the account would look like it holds no profit — and a zero that is really an unknown is the one
failure this whole report exists to avoid.

**Checked against a real broker report.** The year's figures were compared line by line against a
broker's own per-disposal statement. That found one real defect, worth several euros of
understated loss, in how a swap's cost basis was carried. What remains is a cent on each of the
year's gain and loss totals, from splitting one sale's proceeds across many acquisition lots: this
app allocates the cash pro rata so the parts sum to what actually arrived, while the broker prices
each lot independently — which is why *their* rows do not sum to *their* own stated total either.
The pre-filled return is the one to file; this report is for catching euros, not cents.

## Prices and the nightly refresh

A job runs **weekdays at 19:30 Europe/Helsinki**, after Finnish fund NAVs publish: it refreshes FX
from the ECB and every non-`manual` instrument's price, then backfills any instrument whose history
does not yet reach its earliest transaction. It is registered only under `NODE_ENV=production`, so
`bun run dev` never fires a real fetch. Every attempt is logged to `price_fetch_log`; a failing
source degrades that holding's badge to stale rather than breaking the dashboard.

**Which holdings get real history.** Yahoo-priced instruments (listed shares, ETFs) backfill years
of real prices, because Yahoo answers a date range. **Nordnet and OP fund pages do not**: they
expose only today's NAV to an unauthenticated caller, so their history accumulates one point per
evening from your first deployment. Cost basis and current value are right from day one; only the
historical curve for those two sources is short. Nothing will change that, and the nightly sweep
deliberately stops asking.

To run it by hand:

```bash
docker compose exec promptfolio bun -e "
const { getDb } = await import('./src/server/db');
const { runScheduledRefresh } = await import('./src/server/prices/refresh');
await runScheduledRefresh(getDb().db);
"
```

## Backup and restore

Everything is one SQLite file (plus `-wal`/`-shm` while running).

```bash
docker compose stop promptfolio
docker compose cp promptfolio:/data/promptfolio.db ./backup-$(date +%F).db
docker compose start promptfolio
```

Stopping first checkpoints the WAL, so the copy is self-contained. Restore by copying the file
back the same way. Without Docker, the same applies to `DATABASE_PATH`.

## Development

```bash
bun run dev        # hot-reloading server on :3000
bun run check      # lint, format check, typecheck, tests with coverage
bun run db:generate  # a migration from a schema change
```

`bun run check` is the gate: oxlint (including vendored `anti-slop` rules), oxfmt, `tsc --noEmit`,
and the test suite with an 80 % per-file coverage floor. No test may touch the network — a preload
replaces `fetch` with one that throws, so every external call is injected and stubbed.

```
src/core/      pure domain: money, ledger, cost basis, returns, allocation, cash
src/server/    HTTP routes, SQLite access, importers, price sources, chat, spending
src/web/       React frontend (TanStack Router, Query, Charts)
docs/superpowers/specs/  the design document and its amendments
```

`src/core` never sees a database row, and `src/server/valuation.ts` is the one module that
translates between stored integers and the domain's `Money`/`Quantity`/`FxRate`.

## Limits

- **The tax report checks, it does not file.** No euro figure for tax owed (the 30 %/34 % bracket
  depends on capital income this app cannot see), no foreign dividend tax credit, no OmaVero
  export. See the [phase 4 spec](docs/superpowers/specs/2026-08-29-tax-module-design.md) §2.
- **Dividend withholding is not in the ledger.** Both broker exports publish one combined
  "Kulut / Korot / Verot" column, so a dividend's stored amount is what arrived, and the taxable
  85 % is computed on that. Where the payer withheld tax, the real gross is higher — the report
  badges every such row rather than implying certainty.
- **Fund NAV history starts at your deployment** for Nordnet- and OP-priced funds (above).
- **OP's securities export records no cash**, so those accounts show no balance and their
  money-weighted return is measured from purchases instead of deposits.
- **A transfer whose other half is not imported** counts as income or spending. Importing both
  accounts fixes it.
- **Spending classification is substring rules**, not understanding. Unmatched payees land in _Muu_
  and are always reported as a share, so a total is never quietly missing a third of the money.
- **One process, one SQLite file.** The first-run race guard assumes a single process; do not run
  two against the same database.

# PromptFolio

A self-hosted portfolio manager for a Finnish investor holding EUR and USD instruments across
Nordnet, OP, S-Pankki and Danske — listed securities and non-listed mutual funds alike. It answers
one question the spreadsheet it replaces could not: what is this portfolio actually worth, and how
has it grown, in one place, from transaction data you control.

It is a single Bun process: one server serves the API, the built React frontend, and a scheduled
daily price refresh. Data lives in one SQLite file. There is no external database, no message
queue, nothing else to run.

This is Phase 1. It covers the ledger, CSV/paste import from Nordnet and OP, a price/NAV layer,
the holdings view, a growth chart, and authentication. What it deliberately does not cover is its
own section near the bottom of this document — read that section before you rely on this for
anything you can't afford to get wrong.

## Requirements

- **Docker and Docker Compose** (recommended — see "First run" below), or
- **Bun 1.4+** directly, no Docker, no Node.js. `bunfig.toml` sets `[run] bun = true`, so every
  `bun run <script>` — including `oxlint` and `oxfmt`, whose CLI binaries ship a
  `#!/usr/bin/env node` shebang — executes under Bun.

## First run

### With Docker (recommended)

1. Generate a secret and write it to `.env`:

   ```bash
   cp .env.example .env
   echo "BETTER_AUTH_SECRET=$(bun -e 'console.log(crypto.randomUUID()+crypto.randomUUID())')" >> .env
   ```

   `BETTER_AUTH_SECRET` must be at least 32 characters. The process refuses to start without one —
   this is deliberate; a missing or default secret in a self-hosted financial app is a silent
   authentication bypass, so there is no fallback and no example value anywhere that could
   accidentally be used as a real one.

2. Build and start:

   ```bash
   docker compose up --build -d
   ```

   On first boot, the container creates `/data/promptfolio.db` (a Docker volume,
   `promptfolio-data`, so it survives `docker compose down`) and applies every migration to it
   before the server starts accepting requests. This happens on every boot, not just the first —
   migrations are additive and idempotent, so re-running them against an already-current database
   is a safe no-op.

3. Confirm it's up:

   ```bash
   curl -fsS localhost:3000/api/health
   ```

   should print `{"ok":true}`.

4. This is a closed, family instance — there is no public sign-up. Open `http://localhost:3000` in
   a browser: on a fresh instance (no account exists yet) the login page shows a "create your
   account" form instead of the sign-in form. Fill it in once, as the instance's owner, and you're
   signed in. That form disappears the moment an account exists — for anyone, not just you: the
   server refuses a second attempt to use it even if someone finds the URL directly, so there is
   no window after your first visit where a stranger could still claim it. The only real risk is
   racing your own first visit: don't expose a fresh instance to the network before opening it
   yourself.

   To add an account for another family member later, use `ALLOW_SIGNUP` — the same manual gate
   this project has always used, still here for exactly this:

   ```bash
   # in .env: ALLOW_SIGNUP=true, then:
   docker compose up -d

   curl -s localhost:3000/api/auth/sign-up/email \
     -H 'content-type: application/json' \
     -d '{"name":"Family Member","email":"them@example.com","password":"a strong passphrase"}'

   # then in .env: ALLOW_SIGNUP=false (or delete the line — false is the default), and:
   docker compose up -d
   ```

   Sign in at `http://localhost:3000` — there is no general-purpose sign-up form in the UI on
   purpose; only the very first account is ever created through the UI itself.

### Without Docker

```bash
bun install
cp .env.example .env
echo "BETTER_AUTH_SECRET=$(bun -e 'console.log(crypto.randomUUID()+crypto.randomUUID())')" >> .env
bun run build
bun start   # open http://localhost:3000 and use the "create your account" form
```

`bun start` runs migrations itself before serving, exactly like the container does — there is no
separate migration command to remember.

## Importing transactions

Every holding on the dashboard is built entirely from the transactions you import — nothing is
inferred from a live brokerage connection. Import from the "Import" page in the app once signed
in.

### Nordnet

Nordnet → **Egna sidor / Mina sidor → Transaktioner** (or the Finnish equivalent) → export as CSV
for the date range you want, then upload that file on the Import page. The exporter recognises it
automatically by its header shape (UTF-16LE, tab-delimited).

Most rows map cleanly. Two label pairs are deliberately left **unmapped** and surface on the
Import page for manual review rather than being booked automatically:

- **`VAIHTO AP-OTTO` / `VAIHTO AP-JÄTTÖ`** — a same-day share-class swap or fund merger (units of
  one ISIN removed, units of another added). Nordnet's own export has no field that carries a
  correct cost basis for the new ISIN without a real tax-treatment judgement call (is this a
  carried-over basis, or a taxable disposal and reacquisition?) that a CSV row cannot answer.
  Booking it automatically either way risks silently wrong capital-gains data, so it doesn't.
- **`DESIM. ULOSKIRJ. KÄT` / `DESIM KIRJAUS OTTO`** — Nordnet's internal handling of a fractional
  share cash-out. Same reasoning: better to review it once by hand than guess.

Re-importing the same export is safe — every row that was already imported is reported as skipped,
nothing is inserted twice.

### OP

**OP has no CSV export.** Transactions come from copying OP's web transaction table by hand:

1. Go to OP's transaction history, select the table, copy it (⌘/Ctrl+C).
2. Paste the copied text directly into the "Paste from OP" box on the Import page.

OP's web view only shows one page of transactions at a time, and there is no guarantee you'll
import pages oldest-first. **If you import newest-first, a sale whose matching purchase sits on a
page you haven't imported yet will show an unknown cost basis** (a "tuntematon" badge in the
holdings table) until that earlier page is imported too — the app doesn't guess at a purchase
price it hasn't seen. Importing OP pages oldest-first avoids this entirely; if you don't, just
import the missing earlier page later and the badge clears once it lands.

### S-Pankki and Danske

No import path exists for either — no holding at either bank appears in the real exports this
project was built against, so this was never implemented. If you hold anything at S-Pankki or
Danske, add the instrument manually and set its price source to `manual` (see "price source" in
the Phase 1 scope section below).

## What "stale" means on a price

Every holding shows the date of the price it was last valued at. If that date is not today, the
row carries a small **"vanha"** ("old") badge next to it — the number shown is real, just not
current. A holding with no price at all yet shows **"ei hintaa"** ("no price") instead, so it can
never be mistaken for "priced at zero".

A long-running "old" badge on a Nordnet-fund or OP-fund holding is expected, not a bug — see
"Which holdings get real history" below for why those two specifically never clear it.

## Backup and restore

The entire application state is one SQLite file (plus its `-wal`/`-shm` companion files while the
server is running, in WAL mode). There is no other state to back up.

**Docker:**

```bash
docker compose stop promptfolio
docker compose cp promptfolio:/data/promptfolio.db ./backup-$(date +%F).db
docker compose start promptfolio
```

Stopping first checkpoints and closes the WAL cleanly, so the copied file is self-contained and
consistent — copying it while the server is running risks missing whatever is still sitting in
`promptfolio.db-wal` and not yet checkpointed into the main file.

**To restore:** stop the container, copy the backup file back in, start it again:

```bash
docker compose stop promptfolio
docker compose cp ./backup-2026-08-27.db promptfolio:/data/promptfolio.db
docker compose start promptfolio
```

**Without Docker:** the same idea applies directly to `DATABASE_PATH` (default
`./data/promptfolio.db`) — stop the process, `cp` the file, restart.

## The scheduled refresh

A background job runs **weekday evenings at 19:30 Europe/Helsinki** (after Finnish fund NAVs
publish for the day), refreshing FX rates and every non-`manual` instrument's price, then catching
up backfill (see "Which holdings get real history" below) for any instrument whose stored price
history still doesn't reach its earliest transaction. It only runs in the Docker/production build
(`NODE_ENV=production`) — it is not registered at all under `bun run dev`, so editing code locally
never fires a real fetch against ECB, Yahoo, or a broker's price page. Every attempt, success or
failure, is logged to the `price_fetch_log` table; a source that fails degrades that instrument's
badge to stale rather than breaking the dashboard.

To trigger a refresh by hand instead of waiting for the schedule — after importing a fresh price
source, or to check a fix — run this inside the running container:

```bash
docker compose exec promptfolio bun -e "
const { getDb } = await import('./src/server/db');
const { runScheduledRefresh } = await import('./src/server/prices/refresh');
await runScheduledRefresh(getDb().db);
"
```

(Without Docker, run the same snippet from the project root with `bun -e "..."` directly.) There
is no button for this in the UI in Phase 1. This same command also runs the backfill catch-up
described below, so it doubles as the manual way to backfill an existing holding without
re-importing anything.

## Phase 1 scope and known limitations

This section is deliberately unflattering. Read it before trusting a number on the dashboard.

- **Which holdings get real history, and which accumulate from first run.** Every `yahoo`-priced
  instrument (listed stocks and ETFs, and any UCITS ETF) backfills its real
  price history automatically: Yahoo's public chart endpoint answers a `from`/`to` range directly,
  so the growth chart, TWR and XIRR see genuine multi-year data going back to the instrument's
  earliest transaction, not a curve that starts on whatever day you happened to deploy this.
  **Nordnet-fund and OP-fund holdings cannot get this.** Neither broker exposes fund history to an
  unauthenticated caller — Nordnet's public fund page carries only the latest and previous NAV
  (two points), OP's carries only the current one (one point) — so both sources can only ever
  report what today's page shows, never a range. For those two, history accumulates one point per
  weekday evening from whenever you first deploy this and start the scheduled refresh; **the
  growth chart for a Nordnet-fund or OP-fund holding starts from your deploy date, not from when
  you actually bought it.** The rest of the portfolio (transaction-level cost basis, current
  value) is correct from day one either way; only the *historical NAV curve* for these two sources
  is short until it accumulates, and nothing about that will ever change — see
  `backfillMany`'s `NEVER_BACKFILLABLE` comment in `src/server/prices/refresh.ts` for why the
  nightly catch-up sweep deliberately stops asking.

  **When backfill runs.** Automatically, twice: right after an import commits (for every
  instrument that import's rows reference — including a *re*-import of an old export, which is
  how a holding that predates this feature, or whose backfill failed the first time, catches up
  without waiting for anything), and every weekday evening as part of the scheduled refresh, which
  catches up any instrument still missing history for any reason. Both run in the background and
  can never fail or delay the import/refresh that triggered them — a Yahoo outage shows up as a
  failed row in `price_fetch_log`, never as a failed import. To trigger it by hand instead of
  waiting — right after registering a new instrument, say — see "The scheduled refresh" above; the
  same `runScheduledRefresh` snippet runs this catch-up too.

- **OP has no export.** Transactions are pasted from OP's web transaction table, one page at a
  time, and pages may land in any order. If a sale's matching purchase is on a page imported
  later, that holding shows an unknown cost basis (a "tuntematon" badge) until the earlier page is
  imported. See "Importing transactions" above.

- **Two Nordnet transaction types are deliberately unmapped**: the `VAIHTO` share-swap pair and the
  two `DESIM` fractional-share decimal-adjustment rows. Booking either automatically risked
  silently wrong cost-basis/tax data, so both surface for manual review on the Import page instead
  of being guessed at.

- **S-Pankki and Danske have no price source implemented.** No holding at either bank appears in
  any real export this was built and verified against, so `spankki_fund`/`danske_fund` were never
  written. Any instrument at either bank must be configured with `price_source: manual` — you
  enter its NAV/price by hand; nothing tries and fails to fetch it automatically.

- **Uninvested cash is not counted in portfolio value.** This is by design, not an oversight —
  cash sitting in a brokerage account, undeployed, is deliberately excluded from the value and
  return figures shown.

- **Not in Phase 1 at all**, each deferred to its own later spec:
  - Reconciliation UI (catching a broker export against what's already in the ledger)
  - PDF import
  - Screenshot/vision import
  - AI chat
  - The Finnish tax module (Vero export, capital-gains computation)
  - Rebalancing / drift / fee analysis

  See `docs/superpowers/specs/2026-08-27-portfolio-manager-design.md` §2 and §10 for what each of
  these will actually involve when it's built.

# PromptFolio Phase 1 — handover

Written 2026-08-28, revised the same day after the owner imported real data from
both brokers. Branch `feat/phase-1`, 75 commits, 508 tests passing. Nothing is
merged to `master`; `master` is untouched.

## What works

Run it, create the first account in the browser, import from both brokers, and see
holdings, growth, allocation and returns. `docker compose up` from a clean volume
produces a working instance — this was actually run, not just written.

- **Nordnet**: upload the transaction export (UTF-16LE, tab-delimited — its real
  format, with five columns all named `Valuutta`).
- **OP**: copy the web transaction table and paste it; OP publishes no CSV. Paste
  one page at a time, newest first. Sales whose purchases are on a later page show
  "cost unknown" until that page lands, then resolve themselves.
- Re-importing the same input inserts nothing and reports every row as a duplicate.
- Undo removes exactly one import, and refuses if a later sale depends on its units.
- **Unknown instruments resolve themselves.** OpenFIGI supplies the security type,
  Yahoo the ticker, and the listing is chosen by the holding's own currency, so a
  EUR holding is not priced from a USD listing of the same ISIN. A holding with no
  ISIN — OP's paste carries none — resolves by name instead.
- **Corporate actions import.** Share swaps, fractional cash-outs, tender offers,
  rights issues and reverse splits all book correctly, with cost basis following
  the shares across a swap. Verified end to end against a real sequence: shares
  held, more subscribed through a rights issue, consolidated, reverse split at
  1:100, then sold — cost basis at the sale is the sum of both purchases.

## Read this before trusting a number

The single most useful thing done on this branch was comparing the app's figures
against the brokers' own. **One broker's reported return matched to the cent**,
which is real evidence its import and cost basis are right. Do the same check
after any change that touches valuation.

**The two return figures answer different questions.** "Oma tuotto (XIRR)" is
money-weighted — it accounts for when you added money. "Tuotto (aikapainotettu)"
strips that out. They will not agree, and neither will agree with a broker's
"tuotto-%", which is usually simple unrealised return on cost. OP's is; Nordnet's
demonstrably is not.

**Contributions are inferred for OP.** OP's transaction view exports no deposits at
all, so the money that funded its purchases never appears. Contributions are read
from purchases for such an account, and the dashboard says so under the figure.
Without that, a portfolio measured against only the deposits one broker reports
came out at roughly three times its true annual rate.

**A holding with no price yet is carried at cost.** An IPO subscription bought
before its share listed, a delisted line, and a fund whose provider serves only a
few years of history all produce this. Cost is honest for the first and flat-but-
not-invented for the others. The day a holding stops being cost-valued is skipped
by the time-weighted return, because that jump is a change of measuring stick.

**Uninvested cash is not counted** in portfolio value, by design: it measures
investments, not your bank balance. Whether it should be is spec 10c/C2, undecided.

## Known gaps

Recorded in full in the spec's §10c amendments. The ones that can affect a number
you look at:

1. **One Nordnet export can cover several accounts, and the importer merges them**
   (10c/C4, C7). `Salkku` is in every row and is ignored, so an arvo-osuustili and
   an osakesäästötili land as one portfolio. This is why that broker's own reported
   return could not be reconciled against any figure the app computes. **Fix this first.**
2. **Account type does not exist in the model** (10c/C7). An OST is taxed entirely
   differently — untaxed inside, taxed on withdrawal on the gain proportion — and
   phase 4 cannot be built correctly without it.
3. **FX rates have no staleness bound.** `fxOn` takes the newest rate on or before
   the valuation date, however old. That is correct for valuing a historical date
   and is exactly what let a 2010 rate value a 2026 holding in silence (10c/C3).
4. **`unit_price` is stored in the row's cash currency, not the instrument's.**
   Nordnet quotes `Kurssi` in the instrument's currency and `Summa` in euros on the
   same row, so the two disagree by the FX rate on any foreign-quoted holding. Cost
   basis is derived from `amount` and is unaffected — a display defect, not a money one.
5. **A US-listed holding can be mapped to its European line in EUR** when both exist.
   Check the source key of anything whose first price starts later than its first trade.
6. **Fund prices lag one to two days.** Yahoo's `0P…` series is the source; it had
   nothing after 2026-08-26 when checked. Shares and German-listed ETFs are current.
7. **`bun run dev` is broken** — Bun's hot-reload bundler mishandles a circular
   import inside `@tanstack/react-router`. `bun run start` (production) works.
8. **`@tanstack/react-table` is installed and unused.** Keep it or drop it.

## Things I got wrong, and what caught them

The plan I wrote contained real bugs; each was caught by an independent review, not
by me. Rounding that truncated toward zero, a time-weighted return formula that was
wrong twice, a leap-year divisor, double-counted fees, an aborting CSV row, a
negation done by string formatting, a login page nested inside its own auth gate,
and a build that tried to bundle the Tailwind plugin into the browser.

The day the owner imported real data added a second, worse category — code that
produced a confident, plausible number with nothing flagged:

- **ECB's flat CSV files are dead.** Both still answer 200 with valid CSV;
  `eurofxref.csv` stops in 2017 and `eurofxref-hist.csv` in 2010 with placeholder
  cells, which invert into rates off by roughly a factor of five. A holding in that
  currency read several times its real value. Now on ECB's SDMX API.
- **Yahoo's name search is thrown by the legal-form word.** A name with "OYJ" appended does
  not return the Helsinki listing at all; the bare name puts it first. The wrong
  answer was the right company in the right currency on a thinner market.
- **Price history is split-adjusted; share counts are not.** Pre-split shares valued
  at post-split prices invented value that vanished on the split date and read as a
  large one-day portfolio loss.
- **The dashboard rejected its own payload** once an instrument had no ISIN, failing
  the whole page with a generic "could not load" — server 200, browser zod throw.

I also asserted two things without checking, and had to retract both: that the
fabricated FX rows had been hand-inserted (they came from ECB's dead endpoint), and
that a phantom jump was inflating the time-weighted return (`twr` already skipped
those sub-periods). Both were stated confidently before reading the code or the
source involved.

Four of my original assumptions about the brokers were falsified by the real
exports: the file encoding, the delimiter, the existence of an OP CSV, and the
currencies (EUR, SEK and NOK — not EUR and USD). Recorded at §10a.

## Where things are

- Spec: `docs/superpowers/specs/2026-08-27-portfolio-manager-design.md` — §10a holds
  the amendments made from the first real exports, §10b negative positions, and
  §10c everything found on 2026-08-28 (instrument resolution, cash holdings, the FX
  source, Nordnet and OP transaction types, ISIN-less instruments, account type).
- Plan: `docs/superpowers/plans/2026-08-27-promptfolio-phase-1.md`.
- Every ruling, deferral and review finding:
  `.superpowers/sdd/2026-08-27-promptfolio-phase-1/progress.md` (gitignored — a
  working record, not source).
- Phase 2 onward, unstarted: reconciliation, PDF import, screenshot/vision import,
  AI chat, the Finnish tax module, rebalancing.

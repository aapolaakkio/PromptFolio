# PromptFolio Phase 1 — handover

Written 2026-08-28, at the end of the build. Branch `feat/phase-1`, 50 commits,
387 tests passing. Nothing is merged to `master`; `master` is untouched.

## What works

You can run it, log in, import from both brokers, and see holdings, growth and
allocation. `docker compose up` from a clean volume produces a working instance —
this was actually run, not just written.

- **Nordnet**: upload the transaction export (UTF-16, tab-delimited — its real format).
- **OP**: copy the web transaction table and paste it. OP publishes no CSV.
  Paste one page at a time, newest first; sales whose purchases are on a later
  page show "cost unknown" until that page lands, then resolve themselves.
- Re-importing the same input inserts nothing and reports every row as a duplicate.
- Undo removes exactly one import, and refuses if a later sale depends on its units.

## Read this before trusting a number

**Your growth chart starts when you deploy, not in 2020.** Nordnet's price history
needs a logged-in session; the public page carries only today's and yesterday's NAV.
Your holdings and cost basis are complete from the transaction import — it is only
the day-by-day value history that accumulates from first run. Yahoo-priced holdings
could be backfilled, but nothing calls the backfill yet (see Known gaps).

**Your Swedish fund has no value history yet.** Its NAV is quoted in SEK while its
transactions are booked in EUR. Only ECB's current daily rate is ingested, so before
the first refresh it is excluded from historical chart points and allocation slices —
visibly now, with a staleness badge and a named explanation, not silently.

**Four Nordnet transaction types are deliberately not imported**: the `VAIHTO`
share-swap pair and the two `DESIM` decimal-adjustment rows. Every way of booking
them automatically corrupts something — cash, fees, or cost basis — so they surface
for manual review instead. Two rows, once.

**Uninvested cash is not counted** in portfolio value, by design: it measures
investments, not your bank balance. A deposit you have not spent shows as 0,00 €
with an explanation rather than a bare zero.

## Known gaps

All eight of the original gaps are closed except these, and neither can bite you today:

1. **`@tanstack/react-table` is installed and unused.** Your stack choice — keep it and
   add grouping to the holdings table, or drop the package. Nothing depends on it.
2. **A position transferred out in kind collapses the time-weighted return to −100 %.**
   Unreachable through any import path: the only source would be Nordnet's `VAIHTO`
   share-swap rows, which are deliberately unmapped and surface for manual review.
   Only a hand-inserted transfer row could trigger it. Covered by a `KNOWN GAP` test.

## Watch this on first run

**The historical FX parser.** It was built against ECB's documented format, but the
sandbox returned a truncated sample, so it could not be cross-checked against genuine
2020s data. It now refuses loudly if the file does not reach the date it asked for,
rather than storing one ancient row and declaring itself finished. After your first
import of the Nordnet Sverige holding, check that `fx_rates` has SEK rows going back
to that holding's earliest trade — not a single old row.

**A holding with no price yet.** Set an S-Pankki or Danske fund to `manual`, or import
a Nordnet fund before the evening refresh runs, and the return figure will read
"tuntematon" rather than a number. That is correct: a return computed while part of the
portfolio cannot be valued would be a confident guess. Enter a price or wait for the
refresh and it resolves.

## Things I got wrong, and what caught them

The plan I wrote contained real bugs. Each was caught by an independent review of
someone else's work, not by me:

- Floor rounding truncated toward zero instead of down (−2 where −3 was right).
- The time-weighted return formula was wrong, then wrong again in a subtler way:
  it compared a value series of invested positions against cash-account deposits.
  Flat prices with three monthly deposits reported −25 %. Now 0.
- A leap-year divisor that failed its own tolerance.
- Fees counted twice — brokers report totals that already include commission.
- One malformed CSV row aborted the whole import, contradicting my own spec.
- A negation done by string formatting produced `"--500.00"`, silently blanking
  your money-weighted return whenever a withdrawal fell in range.
- The login page sat inside the gate that hides everything from logged-out
  visitors, so the app could not be logged into at all.
- The production build passed the Tailwind plugin as a CLI flag, which made Bun
  try to bundle the plugin into the browser.

Four of my assumptions about your brokers were falsified by your real exports:
the file encoding, the delimiter, the existence of an OP CSV, and the currencies
(EUR and SEK, not EUR and USD). All are recorded in the spec at §10a.

## Where things are

- Spec: `docs/superpowers/specs/2026-08-27-portfolio-manager-design.md` — §10a holds
  the amendments made from your real data.
- Plan: `docs/superpowers/plans/2026-08-27-promptfolio-phase-1.md`.
- Every ruling, deferral and review finding: `.superpowers/sdd/2026-08-27-promptfolio-phase-1/progress.md`
  (gitignored — it is a working record, not source).
- Phase 2 onward, unstarted: reconciliation, PDF import, screenshot/vision import,
  AI chat, the Finnish tax module, rebalancing.

# PromptFolio — handover

Current as of 2026-08-29. Replaces the per-phase handovers for phases 1 and 2, which had gone out
of date in ways that mattered: phase 2's said the PDF import path was dropped, and it has since
been built.

`bun run check`: 848 tests, 0 failures, 80 % per-file coverage floor held.

## What exists

**The ledger.** Append-only transactions across brokerage and bank accounts. Money is integers
throughout — minor units as `bigint`, quantities scaled 10⁶, FX 10⁸ — and decimal strings on the
wire. `src/core` never sees a database row.

**Brokerage import.** Nordnet's CSV (UTF-16LE, tab-delimited, five columns named `Valuutta`) and
OP's pasted web table, which publishes no CSV. Corporate actions book correctly: share swaps,
fractional cash-outs, tender offers, rights issues, reverse splits, with cost basis following the
shares across a swap. Verified end to end against a real sequence. Re-importing inserts nothing;
undo removes exactly one import and refuses if a later sale depends on its units.

**Instrument resolution.** OpenFIGI supplies the security type, Yahoo the ticker, and the listing
is chosen by the holding's own currency so a EUR holding is not priced from a USD listing of the
same ISIN. A holding with no ISIN resolves by name.

**Prices.** Yahoo, Nordnet fund pages, OP fund pages, or manual. ECB SDMX for FX. Nightly refresh
at 19:30 Europe/Helsinki, production only. Yahoo-priced instruments backfill real history; the two
fund sources cannot, and accumulate from first deployment.

**Valuation and returns.** Holdings, allocation, value series, TWR and XIRR. An unpriceable
holding is excluded and named, never valued at zero.

**Reconciliation.** A broker's holdings statement compared against what the ledger derives for the
same day, per instrument, with the delta and what it likely means. Resolving a row writes an
adjusting transaction, one at a time, and never happens as a side effect of looking.

**Bank accounts and cash.** Current, savings and fixed-term accounts alongside brokerage ones.
Statement import from OP (CSV and PDF) and SweepBank/Ferratum (PDF). Cash counts toward value and
allocation, never toward returns.

**Spending.** Category rules in the database, extended by the assistant on import and editable by
hand. Sankey of the period's money, monthly income against spending, per-payee breakdown, and a
list of everything no rule matched.

**The assistant.** Read-only tool calling over the same functions the screens use, with an exact
decimal calculator. Conversations persist per user.

## Decisions worth knowing before changing anything

Each of these was arrived at by getting it wrong first.

- **Returns measure invested capital.** `loadPortfolio` returns `investedTxns` beside `txns`, and
  every return path uses the former. A grocery payment in the return figures reads as capital
  withdrawn.
- **A statement is evidence, never a source.** Reconciliation never overwrites the ledger.
- **Transfers between the owner's own accounts are matched structurally**, not by text: a transfer
  to your own savings carries your own name, and an AI-written rule on that name once turned moved
  savings into income.
- **A PDF import verifies itself** against the statement's printed opening and closing balance and
  is refused when the rows do not account for the difference. This is what makes reading a fragile
  layout acceptable.
- **Rows are identified by the bank's archive id**, which is stable across OP's own two formats —
  so the same period can be imported twice, and the PDF fills in payees the CSV left blank.
- **The model may derive figures but not compute them.** Base numbers come from tools; anything
  derived goes through the calculator, in integer hundredths.
- **Every AI-proposed classification is validated** before it is stored: the category must exist,
  the pattern must occur in a payee the import contained, and an existing rule is never replaced.

## Where the numbers can still be wrong

- **Fund NAV history** for Nordnet- and OP-priced funds starts at your deployment. Cost basis and
  current value are right from day one; the historical curve is short.
- **OP's securities export records no cash**, so those accounts show no balance and their
  money-weighted return is measured from purchases rather than deposits.
- **A transfer whose other half is not imported** counts as income or spending.
- **Classification is substring matching**, not understanding. What matches nothing lands in *Muu*
  and is always reported as a share of the total.
- **`transactions.unit_price` is denominated in the instrument's currency** while
  `transactions.currency` describes the cash side. `valuation.ts` reads it correctly; anything new
  that touches it must too.

## Not built

- **Tax reporting.** Account types are recorded (`aot`, `ost`), but Finnish capital-gains rules,
  OST withdrawal treatment and the vero.fi export are not implemented. This is the next phase; see
  spec §10c/C7 for why the account type had to exist first.
- **Rebalancing, drift and fee analysis.**
- **Debt as an account.** A loan repayment is currently one spending category; principal and
  interest are not separated. See spec §10f.

## Layout

```
src/core/      money, ledger, cost basis, returns, allocation, cash — no I/O
src/server/    routes, SQLite, importers, price sources, chat, spending
src/web/       React frontend (TanStack Router, Query, Charts)
docs/superpowers/specs/2026-08-27-portfolio-manager-design.md
               the design document; §10a–§10f are amendments made as reality
               contradicted it, and they are the most useful part to read
```

`bun run check` runs oxlint (with the vendored `anti-slop` rules), oxfmt, `tsc --noEmit` and the
suite. No test may touch the network: a preload replaces `fetch` with one that throws, so every
external call is injected.

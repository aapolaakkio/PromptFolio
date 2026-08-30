# PromptFolio — handover

Current as of 2026-08-30 (phases 4 and 5 shipped). Replaces the per-phase handovers for phases 1 and 2, which had gone out
of date in ways that mattered: phase 2's said the PDF import path was dropped, and it has since
been built.

`pnpm run check`: 985 tests, 0 failures, 80 % per-file coverage floor held.

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

**Tax figures.** One tax year at a time, computed from the ledger to check the pre-filled return:
realised gains both permitted ways, dividends at 85 %, OST withdrawals apportioned, losses carried
five years. Every rule cited to vero.fi in `core/tax/rates.ts`. No tax owed is stated. Reconciled
line by line against a broker's own per-disposal report: agrees to a cent on the year's totals,
and the disagreement that was larger turned out to be a real defect in this code, not in theirs.

**Targets and rebalancing.** A target allocation on one dimension, the drift against it in points
and euros, where to direct new money, a full-rebalance plan in which every sale states the gain it
would realise, and fees per year with withheld tax kept out of them.

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
- **FIFO is per account**, which is the rule vero.fi states. `buildLots` keyed lots by instrument
  alone until phase 4; that pooled them across accounts, and only agreed with the real rule while
  an instrument was held in one account. Cost basis still aggregates per instrument for the
  holdings view: a position spans accounts, tax does not.
- **A suggestion always states what it costs.** Drift is arithmetic and always shown; the sell view
  is a deliberate disclosure, and each sale carries the gain FIFO would realise. Naming the gain is
  the difference between a calculation and an unmarked recommendation to trigger a tax event.
- **New money is the default remedy for drift**, because directing a deposit realises nothing.
  Selling is asked for, never offered first.
- **Withheld capital income tax is not a fee.** The broker books it as one; it is tax on a gain. It
  is excluded from fee totals and reported under its own name.
- **The tax module reports taxable income, never tax owed.** The 30 %/34 % bracket depends on
  capital income the app cannot see, so those rates appear nowhere in the code.
- **Nothing inside an OST is taxed when it happens.** Sales and dividends there are excluded from
  the taxable sets; tax falls on withdrawal, and the account is valued immediately _before_ the
  withdrawal being apportioned — valuing it after understates the total the profit is divided by.
- **A withdrawal after an unvaluable one is reported as unknown, not computed.** The earlier gap
  leaves the deposits too high by an unknown amount, so the account looks like it holds no profit.
  Carrying on regardless produced a 0,00 € taxable figure for withdrawals the broker had actually
  withheld tax on — found only because the broker's withheld figure sits beside ours.
- **A swap carries its lots, not a merged total.** Each keeps its acquisition date (which sets the
  deemed-cost percentage) and its own cost (which FIFO consumes on a later partial sale). Merging
  them made a fractional cash-out take cost pro rata across the whole position instead of from the
  oldest lot, understating the basis of every remaining share until they were sold.
- **Every AI-proposed classification is validated** before it is stored: the category must exist,
  the pattern must occur in a payee the import contained, and an existing rule is never replaced.

## Where the numbers can still be wrong

- **Lot proceeds are allocated pro rata, with the remainder on the last lot**, so they sum exactly
  to the cash received. A broker instead prices each lot independently, so individual lots can
  differ by a few cents (and a broker's own rows need not sum to its own stated total). Matching
  that would mean reproducing their rounding rather than being correct.
- **Dividend withholding is absent from the ledger.** Both broker exports publish one combined
  "Kulut / Korot / Verot" column, so a dividend's amount is what arrived and the taxable 85 % is
  computed on it. Where the payer withheld, the true gross is higher; every such row is badged.
- **Fund NAV history** for Nordnet- and OP-priced funds starts at your deployment. Cost basis and
  current value are right from day one; the historical curve is short.
- **OP's securities export records no cash**, so those accounts show no balance and their
  money-weighted return is measured from purchases rather than deposits.
- **A transfer whose other half is not imported** counts as income or spending.
- **Classification is substring matching**, not understanding. What matches nothing lands in _Muu_
  and is always reported as a share of the total.
- **`transactions.unit_price` is denominated in the instrument's currency** while
  `transactions.currency` describes the cash side. `valuation.ts` reads it correctly; anything new
  that touches it must too.

## Not built

- **Filing.** The tax module verifies; it does not file. No tax owed, no foreign dividend tax
  credit, no OmaVero export, no unlisted-dividend regime. See the phase 4 spec §2.
- **Whether to rebalance.** The app shows the gap and what closing it costs; it never says now is
  the time. Nor does it choose which lots to sell for the smallest gain, or place any order.
- **Freezing a filed tax year.** Figures are derived, so a late import changes a past year. The
  report says what it was computed from; a `tax_reports` table is the alternative, not built.
- **Debt as an account.** A loan repayment is currently one spending category; principal and
  interest are not separated. See spec §10f.

## Layout

```
src/core/      money, ledger, cost basis, returns, allocation, cash, tax,
               rebalance — no I/O
src/server/    routes, SQLite, importers, price sources, chat, spending
src/web/       React frontend (TanStack Router, Query, Charts)
docs/superpowers/specs/2026-08-27-portfolio-manager-design.md
               the design document; §10a–§10f are amendments made as reality
               contradicted it, and they are the most useful part to read
```

`pnpm run check` runs oxlint (with the vendored `anti-slop` rules), oxfmt, `tsc --noEmit` and the
suite. No test may touch the network: a preload replaces `fetch` with one that throws, so every
external call is injected.

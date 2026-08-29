# PromptFolio — Phase 5: rebalancing, drift and fees

Status: Approved (design). Implements phase 5 of the
[portfolio manager design](2026-08-27-portfolio-manager-design.md), which scoped it as
"rebalancing, drift and fee analysis" and answers §1's third question: *where have I drifted from my
target allocation, and what am I paying in fees?*

## 1. Purpose

Everything the app computes so far describes what happened. This phase is the first that says what
to *do* about it — and that changes the standard of care. A wrong return figure misleads; a wrong
rebalancing suggestion loses money and can trigger a tax bill nobody asked for.

The design therefore separates the two halves cleanly: **drift is arithmetic** and is always shown,
while **a suggestion is advice** and always shows what it costs before you act on it.

## 2. Scope

**In scope.** A target allocation the owner sets; drift against it in percentage points and euros; a
suggestion for where to direct new money; a full-rebalance view showing buys and sells with the
realised gain each sale would trigger; a fee report per year, broker and instrument.

**Deliberately out of scope:**

- **Advice on whether to rebalance.** The app shows the gap and the cost. The decision is the
  owner's, and a threshold dressed up as a recommendation ("you should rebalance now") is a
  judgement no ledger supports.
- **Tax-aware sell ordering.** Choosing which lots to sell to minimise the gain is a real feature
  and a different one; the full-rebalance view names the gain FIFO would realise (§6.3) and stops.
- **Automatic execution.** Nothing here places an order. There is no broker connection and there
  will not be one.
- **Forecasting.** No projection of future value, and no "you would have earned X had you
  rebalanced" — the counterfactual needs assumptions this app does not have.

## 3. Targets

A target is a percentage of the portfolio's total value assigned to one key of one dimension, for
one user.

- **One dimension at a time.** `core/allocation.ts` already slices by `kind`, `currency`, `account`
  or `instrument`. A target set is bound to exactly one of these. Targets across two dimensions at
  once can contradict each other — 60 % equities and 50 % Nordnet are individually reasonable and
  jointly unsatisfiable — and no useful drift figure comes out of an unsatisfiable pair.
- **The set must sum to 100 %.** Enforced when saved, not silently normalised: a set summing to
  90 % means the owner forgot a slice, and inventing the missing 10 % would hide that.
- **A key with no target is not zero.** It is untargeted, and reported separately from a slice
  deliberately targeted at 0 %. "I have not decided" and "I want none of this" are different
  statements about a holding.

### 3.1 Storage

One new table, `allocation_targets`: `id`, `user_id`, `dimension`, `key`, `weight_bp`, `created_at`.

The weight is stored in **basis points as an integer** (6 000 = 60 %), not a float. This follows
§4.1's rule that nothing quantitative is a float, and it makes "sums to exactly 100 %" a check on
integers rather than an epsilon comparison.

Replacing a target set is a single transaction: delete the user's rows for that dimension, insert
the new ones. A half-applied set that sums to 43 % must never be reachable.

## 4. Drift

Actual weight minus target weight, per key, in both units the question is asked in:

- **percentage points** — how far off the shape is;
- **euros** — how much would have to move to correct it.

Both come from `allocateBy`, so the drift screen and the allocation screen cannot disagree about
what a slice is worth.

**A tolerance band, default 5 percentage points**, decides whether a slice reads *tavoitteessa* or
drifted. Without one every slice is always drifted by some amount and the screen trains the reader
to ignore it. The band is a display threshold only: the underlying figure is always shown.

**An unvaluable holding suspends the drift figure for its slice.** Weights are a share of a total,
so one unpriceable holding makes every other slice's drift wrong by an unknown amount rather than
just its own. The slice reports the gap as unknown and names the holding, the way
`holdingsFor` already does.

## 5. Where to put new money

Given an amount, the app answers: which slices, and how much each.

The rule is greedy and stated in one line: **fill the most underweight slice first, then the next,
until the money runs out** — where "underweight" is measured in euros against the target applied to
the *post-deposit* total, since adding money changes every weight.

Exact integer arithmetic in cents, with the remainder going to the largest allocation so the parts
sum to the amount deposited.

This is the default because it is the one action that cannot go wrong: no sale, no realised gain,
no tax, and it moves the portfolio toward target by construction.

## 6. Full rebalance

A separate view, reached deliberately, never the default.

### 6.1 What it computes

The buys and sells that put every slice exactly on target, ignoring new money. Sells first, then
buys of the same total, so the plan is self-funding.

### 6.2 Minimum trade size

A trade below a floor (default 50 €) is dropped and its drift left uncorrected. Every broker
charges a minimum commission, and a 3 € trade to correct 0,2 pp of drift costs more than the drift.
The dropped trades are listed, not hidden — the owner may have a reason to make one anyway.

### 6.3 What a sale would cost

**Every suggested sale shows the realised gain it would trigger**, computed FIFO through
`core/costbasis.ts`, and the view totals them.

This is the section the phase exists to get right. A rebalancing tool that says "sell 4 000 € of X"
without saying "this realises 1 900 € of gain" is not neutral: it is quietly recommending a taxable
event. The figure is a gain, not a tax — the tax depends on the owner's other capital income, which
phase 4 §2 already refuses to guess at — and it is labelled as such.

A holding whose cost basis is unknown (`costBasisError`) reports the gain as unknown and the sale is
still listed. Refusing to show the trade would hide a real option; claiming a gain of zero would be
worse.

## 7. Fees

Per year, and within a year per broker and per instrument:

- **Trade fees** — `transactions.fee`, which is already fee-inclusive in `amount` (see
  `Txn.amount`) and is carried alongside precisely for reporting like this.
- **Charged fees** — `FEE` transactions, which are the broker's own charges: service fees on a
  monthly savings plan, custody fees.
- **Fee drag** — the year's total fees as a share of the portfolio's average value that year, so a
  figure in euros becomes one that can be compared against a return.

### 7.1 The trap: tax is not a fee

On an equity savings account the broker withholds capital income tax and books it as a `FEE` row —
`PÄÄOMATULOVERO OST` — for the reason `import/brokers.ts` documents: the money leaves permanently
without reaching the investor, and calling it a withdrawal would tell the money-weighted return it
was money taken out and enjoyed.

For a fee report it is not a cost of investing at all. In the real ledger these rows are a majority
of the `FEE` total in the years they appear, so counting them would overstate fees by more than
half and make the fee-drag figure meaningless.

They are excluded, identified by the broker's own row text now that imports keep it (`note`
matching the withheld-tax label) and by sitting on an account whose type is `ost`. The report says
that it excludes them, and reports the excluded total separately — a figure the owner should see,
just not under "fees".

## 8. Module boundaries

New, pure, no I/O, under `src/core/rebalance/`:

| File | Responsibility |
| --- | --- |
| `targets.ts` | The target set as a domain type; the sums-to-100 % check |
| `drift.ts` | Actual against target, in points and euros, with the tolerance band |
| `deposit.ts` | Where to direct a given amount |
| `plan.ts` | Full rebalance: sells, buys, minimum size, realised gain per sale |
| `fees.ts` | The fee report, and the exclusion of withheld tax |

`src/server/rebalance.ts` translates to decimal strings and resolves names; `src/server/api/rebalance.ts`
serves `GET /api/targets`, `PUT /api/targets`, `GET /api/drift`, `GET /api/rebalance`, `GET /api/fees`.
`src/web/routes/rebalance.tsx` is a **Tasapaino** tab. A `get_drift` chat tool reads through the
server layer, like every other tool.

## 9. Testing

Per §9.4 and the 80 % per-file floor:

- A target set that does not sum to 100 % is refused, and the error says by how much.
- An untargeted key is reported as untargeted, never as a 0 % target.
- Drift inside the band reads as on-target while still carrying the figure.
- A deposit's allocations sum exactly to the amount deposited, including when the split does not
  divide evenly.
- A full rebalance's sells and buys balance; trades below the floor are dropped and listed.
- A suggested sale carries the FIFO gain it would realise; one with unknown cost basis says so.
- Withheld capital income tax is excluded from fees and reported separately.
- An unvaluable holding suspends drift for every slice, not only its own.

## 10. Not built

Whether to rebalance, tax-aware lot selection, execution, forecasting (§2); multi-dimension targets
(§3); and any figure for tax owed on a suggested sale (§6.3).

# Debts as bank accounts, interest rates and availability — design

Date: 2026-11-10. Status: draft for the owner's review. Changes `2026-11-10-debts-design.md`: step 1 of that design (a separate Debts tab with its own tables) is built and on `master`; this design folds it into the accounts the app already has. Where the two disagree, this one wins once approved.

## Why

The owner's words:

- "Could the debts be included in the bank accounts? Then the credit card could be automatically included in both. Also a debt is often just a negative amount of money with interest. At the same time we could add the interest rates for the other bank accounts"
- "Also we could make it possible to edit the availability of the accounts so that the maturity date of the fixed term accounts can be set."
- "Interest rates should be used in the estimates and maybe tax?"
- "No migration needed. The delete account could be added for other reasons also, or it actually it could be more like close account. I debt isnt needed after it is paid and if a bank account is closed it also isnt needed in the app"

A credit card is today two unrelated things: a bank account of type `credit` (its statement feeds Spending) and, since this morning, a hand-typed row on the Debts tab. One import should feed both. And a savings account with 2 % and a loan with 4 % are the same shape: a balance and a rate.

## What exists today (read from the code)

- `accounts` already has `accountType` (`current`, `savings`, `fixed_term`, `credit` for banks), `maturityDate` ("when a fixed-term deposit comes free") and `interestRateBp`. The server accepts both on create and update (`src/server/accounts.ts`; a maturity date is refused on any type but `fixed_term`), the assistant can propose them, and a bank statement can state a maturity date.
- The account form in the browser (`CreateAccountForm.tsx`, `RenameAccount.tsx`) offers only name, broker, kind, type and currency. So today the rate and the maturity date can be set only through the assistant or an import. This is the gap behind the owner's second remark.
- `fixed_term` money is already shown as locked until its maturity date (`src/server/valuation.ts`).
- A `credit` account's rows are left out of cash (`cashTxns` in `loadPortfolio`): "a card holds no money, so its balance would subtract the same spend twice".
- `debts` and `debt_balances` (per user; a dated owed amount typed by hand; the latest one is the debt's value, no arithmetic between them), a Debts tab, and on the Dashboard a "Net worth" figure and chart.
- Nothing uses `interestRateBp` in any calculation. The forecast (`src/core/forecast.ts`, `src/server/forecast.ts`) reads instruments only.
- A `credit` account's rows already count in Spending, and a bill payment from a current account already pairs with the card's incoming row as a move between own accounts (`internalTransferIds`: same amount, within 5 days, different accounts; covered by `cashflow.test.ts`).
- The Cash page is built from `cashTxns`, so a card does not appear on it today.
- The list of bank types lives in three places: the schema enum, `src/server/action-inputs.ts` and `src/web/routes/account-type.ts`; the assistant's tool text names them too.
- Net worth is computed in two places in `src/server/views/portfolio.ts` (`valueSeriesView`, `returnsView`), both from `debtBalancesFor`. Debts are euros only.
- There is no way to delete an account, in the browser or through the assistant.
- `src/server/tax.ts` does nothing with `INTEREST` rows.
- "Debts" is also named in the assistant's prompt (`chat/runner.ts`), `page-line.ts`, `page-context.ts`, `starters.ts`, the nav in `session-gate.tsx` and the route tree.

## Goals

1. A debt is a bank account. One place to add it, one import to feed it.
2. A credit card's imported statement gives both its spending and what is owed.
3. Every bank account can carry an interest rate, editable in the browser.
4. The maturity date of a fixed-term account is editable in the browser.
5. Interest rates are used in estimates: interest per year on Cash, and money and debts in the forecast.
6. An account that is no longer in use (a paid debt, a closed bank account) can be closed and leaves the app's lists.

## Non-goals

- Payment plans, amortisation schedules, matching of repayments by rhythm (steps 2–3 of the earlier design stay deferred, and need the owner's real statement layout).
- A history of rate changes. A rate is "what it is now".
- Any connection to a bank. Nothing is fetched.

## Anti-goals

- Counting a card purchase twice (once as spending on the card, again when the bill is paid).
- A total that changes without the owner being told why (closing an account never removes money from today's totals).
- Presenting an interest or tax estimate as a fact.

## Design

### 1. Account types

Bank types become: `current`, `savings`, `fixed_term`, `credit` (credit card), and new `loan`. A debt is a bank account whose type is `credit` or `loan`. No new kind: `kind` stays `brokerage | bank`.

### 2. What an account is worth

| Type                               | Balance comes from                                                                                        | Why                                                                                                                 |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `current`, `savings`, `fixed_term` | the sum of its rows, as today                                                                             | unchanged                                                                                                           |
| `credit`                           | the sum of its imported rows (purchases negative, bill payments positive); a negative sum is what is owed | the owner: "the credit card could be automatically included in both"                                                |
| `loan`                             | the latest stated balance on or before the day; no arithmetic between two stated balances                 | the owner, earlier: "It should just accept the value and changes from the imports not calculate the changes itselt" |

Stated balances live in a new table keyed by account, replacing `debt_balances` (`account_balances`: account with delete cascade, date, owed amount ≥ 0 in the account's currency, source `manual | import`, `import_id` kept as it is today, unique per account and date).

Rules that follow:

- A `loan` account's rows, if any are ever imported, are left out of cash exactly like a card's (the same account set everywhere: out of `cashTxns`, in what is owed). Its value is the stated balance only.
- A `credit` account with no rows may be given a stated balance by hand, so a card whose statements are not imported can still count (my call). Once it has rows, the rows decide and stated balances are ignored; the page says which one is used.
- **A card's starting point.** A first statement rarely starts at zero. The app already has an `OPENING_BALANCE` row type ("what an account held when its history begins"): the account form asks "Owed when the first imported statement begins" and stores it as that row (my call). Without it the card shows too little owed, and the form says so.
- **Counted from.** A card counts as owed from the date of its first row (opening balance included); a loan from its first stated balance. Before that date it counts as zero and the chart note names the date, as today.
- **Currency.** A card or loan in another currency is converted with the same rates as cash (my call; the earlier design had euros only).

### 3. Net worth

Net worth = everything owned − everything owed, where owed is the sum over `credit` and `loan` accounts of what each owes (never below zero: a card in credit is money owned). The Dashboard keeps both charts ("Net worth over time", "Value over time (before debts)") and the note saying from which date debts are counted.

No double count: a purchase on the card raises what is owed on the day of purchase and is spending that day; paying the bill lowers cash and lowers what is owed by the same amount, so net worth does not move, and the payment row on the current account is a move between own accounts, not spending. The existing own-transfer matching already pairs the two rows when both statements are imported.

Known limits, shown to the owner rather than hidden:

- If the card's statement is not imported, a bill payment on the current account is an ordinary outgoing row. The earlier design's rule ("the owner points at one bill payment once") is still deferred, so until then such a payment is categorised by hand or by a spending rule.
- Bill payments made before the card's first row lowered cash at the time, while the card counted as zero: the net worth chart is too low before the "counted from" date by what was then owed. The note under the chart says from when the card is counted.
- Incomplete card rows (a missing month) make what is owed wrong. The Cash page shows the date of the card's latest row so a gap is visible.

### 4. Where it shows

- **Cash page**: two groups, "Money" and "Owed". Each account row shows balance, rate, interest per year (estimate), and for fixed-term its maturity date and whether it is locked.
- **Debts tab**: removed, with its mentions in the nav, the assistant's page list, starters and prompt; its content is the "Owed" group on Cash, which is a new query since cards are not on Cash today (my call: one place, as the owner asked; say so if the tab should stay as a shortcut).
- **Close account**: see section 8.
- **Account form** (create and edit): gains "Interest rate %" for every bank account and "Maturity date" for `fixed_term`. For `loan` and `credit`: "Balance owed on a date".
- **Spending**: unchanged. Card purchases are spending; card interest and fees are spending under "Loans and credit".

### 5. Interest rates in estimates

- **Interest per year** on Cash: balance × rate, per account, with a total earned and a total paid. Labelled "estimate at today's rate". For `fixed_term`: up to the maturity date when that is within a year.
- **Forecast**: two new lines beside investments, "Cash" and "Owed", each growing monthly at its account's rate; "Net" = investments + cash − owed. No payments, draws or new deposits are modelled (the note says so); an account without a rate stays flat. The engine for investments (`src/core/forecast.ts`) is not changed; the new lines are computed beside it.
- **Assistant**: sees accounts with type, rate, maturity date, what is owed and net worth; the prompt line saying debts are not visible is removed. Changes still go through Confirm cards.

### 6. Tax ("maybe tax?")

My understanding of Finnish rules, to be checked against vero.fi before anything is shown as a rule:

- Interest on a deposit in a Finnish bank is taxed at source (lähdevero, 30 %), withheld by the bank; it is final and not declared.
- Interest on a consumer loan or a credit card is not deductible. Student loan interest is not deductible either (the student loan deduction is based on repaid principal for degrees finished on time, and is handled by the tax office from Kela's data).

So the proposal: the interest-per-year estimate shows a second figure "after 30 % source tax" for money accounts, labelled as an estimate; and the Tax page gains a small read-only line per tax year, "Deposit interest received", summed from imported `INTEREST` rows of money accounts (new code: the tax module ignores these rows today), with the note that the bank has already withheld the tax. Nothing about debts on the Tax page. If the owner wants less, drop the Tax page line; the estimate alone covers "used in the estimates".

### 7. Availability

The maturity date becomes editable in the account form for `fixed_term`. The existing rules stay: locked until that date, a date on any other type is refused, and a statement that states a different date raises the existing conflict message. No other "availability" setting is added (my call: the owner named fixed-term maturity; notice periods on savings accounts can come later if wanted).

### 8. Closing an account, and no data migration

**Close account.** Any account, bank or brokerage, can be closed from the account form, with a closing date (default today). The owner: "I debt isnt needed after it is paid and if a bank account is closed it also isnt needed in the app".

- A closed account leaves the Cash page, the account pickers (Imports, forms) and the assistant's account list. Its rows stay: history charts, Spending, Tax and past net worth still count them, because they happened.
- Closing is refused with a clear message while the account still holds something on the closing date: a balance other than zero, something owed, or holdings (my call: a closed account with money in it would make that money vanish from today's totals). The message says what is left.
- A closed account can be reopened from a "Closed accounts" list at the bottom of the Cash page (my call).
- Stored as a nullable closing date on `accounts`. Nothing is deleted; there is no "delete account" in this design.
- The assistant can propose closing and reopening through Confirm cards, like other account changes.

**No data migration.** The owner: "No migration needed". The `debts` and `debt_balances` tables are dropped as they are; debts typed on the Debts tab are not carried over, and the owner adds them again as `loan` or `credit` accounts. The schema change itself (new type, new table, closing date, dropped tables) still runs through `pnpm db:migrate:local` as usual.

### 9. What is left to the builder

Names of functions and files, the exact layout of the Cash page, how the forecast lines are drawn, and test structure. Browser tests: `e2e/debts.spec.ts` is rewritten against the Cash page and the account form; `e2e/cash.spec.ts` gains rate, maturity and interest-per-year.

## How the earlier debts steps change

| Earlier step                                 | Now                                                                                             |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 1 Debts tab, net worth                       | Built; reworked by this design                                                                  |
| 2 Plan rows and plan matching                | Deferred, unchanged                                                                             |
| 3 Rhythm matching                            | Deferred, unchanged                                                                             |
| 4 Import recipe for debt statements          | Card: the ordinary bank import into a `credit` account. Loan: a statement balance import, later |
| 5 Forecast overlay, summary facts, chat tool | Forecast and chat are in this design; weekly summary facts later                                |

## Calls I made (the owner can overrule each)

1. New type `loan`; no new account kind.
2. Card balance from rows; loan balance from stated balances only.
3. A card without rows may take a typed balance; rows win once they exist.
4. Debts tab removed; "Owed" group on Cash.
5. Forecast lines grow at the rate only; no payments modelled.
6. Tax: an after-source-tax figure in the estimate and one read-only line on the Tax page; nothing for debts.
7. Only fixed-term maturity for availability.
8. Closing is refused while the account still holds money, debt or holdings; closed accounts can be reopened.
9. A card's start is an opening balance the owner types once.
10. Debts in other currencies are converted like cash.
11. A closed account keeps its rows, so history, Spending and Tax do not change.

## Checked by a reviewer

A second reader checked this document against the code on 2026-11-10; its corrections are folded in above. Still unproven until built: that every reader of cash and of what is owed uses the same set of accounts.

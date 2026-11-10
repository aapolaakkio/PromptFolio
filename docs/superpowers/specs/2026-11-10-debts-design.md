# Debts and net worth: design

Date: 2026-11-10. Status: draft, waiting for the owner's approval.

## Intent

PromptFolio shows what the household owns: securities and cash. It does not know what the household owes, so every total is too rosy and loan payments look like plain spending. The owner has two debts, a student loan and a credit card, and wants them tracked the way investments are: brought in through Imports, matched against bank rows, and counted in every number.

## Goals

1. A **Debts tab** listing each debt: amount owed, interest rate, next planned payment, payment plan, and the debt over time.
2. **Net worth** (owned minus owed) in every total: Dashboard, the value-over-time chart, forecast, weekly summary and chat.
3. A **gross-only chart** (before debts) stays available next to the net one.
4. **Payments matched** to debts, so a loan repayment or a card bill is a move, not spending. Only interest and fees are spending.
5. **Rhythm matching** (same payee, about the same day each month) for debt payments and for monthly investment payments. The owner confirms a rhythm-only match once.
6. Debt data arrives through the **Imports drop box and paste box**, read by an AI-written, verified recipe, like every other document.

## Non-goals

- Debts other than a student loan and a credit card (no mortgage, car loan, loans between people).
- Anything on the Tax page.
- Returns, allocation and rebalance: unchanged, they describe investments only.
- A live bank connection. No orders, no payments made by the app.
- Currencies other than EUR for debts.

## Anti-goals

- A debt counted twice (card purchases already lower nothing today; they must lower net worth exactly once).
- A text rule silently turning income or spending into a "move". Pairing by amount stays the stronger proof; rhythm alone needs the owner's Confirm once.
- A wrong sign: owed is stored as a positive number and always subtracted.
- Account numbers or loan numbers reaching the model unmasked (existing masking in `src/server/chat/mask.ts` applies to all new model calls).
- Anything saved from chat without a Confirm card.

## What the owner said (decisions, as given)

- Only student debt and credit card debt.
- The card is sometimes paid in full, sometimes carries a balance.
- Debts get their own tab, and are included in all numbers.
- Keep a gross-only chart as well.
- Debt data comes in through the same kind of import as everything else; the owner copy-pastes it from the web bank.
- What the owner expects to have for the loan: the payment plan, the amount left, the interest rate. The exact layout is not known yet.
- Rhythm matching is wanted for both debt payments and investment payments.
- Card purchases stay spending; the bill payment is a move; card interest and fees are spending.
- Student-loan repayment lowers the balance; its interest is spending.

## How it works today (for the builder)

- `accounts.accountType` already has `"credit"` (label "Credit card", a `bank` kind account). Card statements import as bank statements. `loadPortfolio` in `src/server/valuation.ts` leaves credit accounts out of `cashTxns`, so a card's balance counts nowhere.
- `src/server/spending/internal.ts`: `internalTransferIds` pairs an outgoing and an incoming row of the same amount on two own accounts within `WINDOW_DAYS` (5); `investmentPaymentIds` pairs a bank payment with a BUY on a cash-less broker account; `notSpendingIds` is the one definition of "a move, not a cost".
- `src/server/spending/recurring.ts`: `recurringPayments` already finds rhythms (same payee, three or more times, gaps inside a cadence window, amounts within 15 %).
- Imports: `src/server/import/sort-documents.ts` sorts dropped files into kinds; `src/server/import/recipe/` writes and verifies recipes (`ask.ts`, `generate.ts`, `verify.ts`), stored in `import_recipes`; pasted text goes through `src/server/import/service.ts`. Imports are drafts until committed and can be undone by `importId`.
- Totals: `valueSeriesView` in `src/server/views/portfolio.ts`, `cashFor` in `src/server/valuation.ts`, `forecastFor` in `src/server/forecast.ts` with the engine in `src/core/forecast.ts`, `SummaryFacts` in `src/server/summary/facts.ts` (checked by `summary/check.ts`: every key starting with `change` must be described with a direction).
- Chat: read tools in `src/server/chat/tools*.ts`, Confirm cards in `proposals*.ts`, danger style derived from the action in `proposal-schema.ts`.
- Money is integer minor units (`core/money.ts`); balances are derived from rows, not stored.

## Design (my calls unless marked as the owner's)

### Data

Four small tables, all per user, removed with the user:

- `debts`: name, kind (`student_loan` | `credit_card`), interest rate in basis points (nullable), linked account id (nullable: the card's existing `credit` account).
- `debt_balances`: debt, date, amount owed (positive minor units), source (`import` | `manual`), import id. One per debt and day.
- `debt_plan_rows`: debt, due date, repayment part, interest part, fee part, import id.
- `payment_matches`: a payee pattern the owner confirmed, and what it means: payments to a given debt, or monthly investing.

Enum columns in this schema carry no SQL CHECK, so new kinds need one migration for the new tables only.

### Amount owed on a day

Owner's call: the app accepts the value and its changes from the imports and does not calculate changes itself.

So for both debts the amount owed on a day is the latest imported (or hand-typed) balance on or before that day. Nothing is added or subtracted between balances: matched payments, card purchases and loan draws never move the number. The debt-over-time chart is a step line through the balances. Before the first balance the debt is unknown and counts as zero; the chart says so. The Debts tab shows the date of the latest balance so a stale one is visible.

Matching (below) therefore decides only one thing: whether a bank row is spending, income or a move.

### Matching payments

In order of strength:

1. **Pair** (existing): a bill payment out of the current account with the same amount arriving on the card account. Already a move.
2. **Plan** (new): an outgoing bank row whose amount equals a plan row's total and whose date is within `WINDOW_DAYS` of its due date. Each row and plan row used once. The plan gives the split: repayment is a move, interest and fee are spending in the existing `loans` category.
3. **Rhythm** (new): `recurringPayments` finds a monthly payee. The Debts tab (and the assistant) offers "These payments look like your student loan" or "…your monthly investing"; on Confirm the payee goes into `payment_matches` and matching rows count from then on, past and future. Without a plan row, the interest part is estimated from the debt's rate and shown as an estimate.

What a confirmed match covers (my call): rows whose payee text contains the pattern AND whose date is within `WINDOW_DAYS` of the payee's usual day of the month. The amount is free, so a card bill that varies still matches; a fee the same bank charges on another day does not. A plan match always wins over a rhythm match for the same row.

Card bills cannot be suggested by `recurringPayments` (it drops payees whose amounts drift over 15 %). So for the card the owner points at one bill payment on the Debts tab ("this row paid the card"), and that payee and day become the confirmed match. Same Confirm, different starting point.

Monthly investing (my call): `investmentPaymentIds` already covers payments that have a purchase. A confirmed rhythm only adds rows with no purchase yet: they stop being spending, nothing else. The Debts tab does not handle them; Spending lists them as "Invested, purchase not imported yet" so missing broker files are visible, since that money is not in net worth until the purchase is imported.

Rhythm match with no plan row and no rate (my call): the whole payment is a move, and the debt shows "interest unknown: add a rate".

Loan draws (owner's call: more loan will be taken): an incoming bank row from the lender is a move, not income. It is found the same way as payments: a confirmed payee match, started by the owner pointing at one draw row. The new, higher debt arrives with the next imported balance.

A row matched in part (repayment plus interest) is new for the spending views: today a row is spending or not. Left to the builder how; the requirement is that Spending, the cash-flow chart, the weekly summary and chat all show the interest and fee as spending and the repayment as a move, from one shared definition next to `notSpendingIds`.

### Import

- New sort kind "debt statement" and a new recipe kind. The recipe yields: a balance (date, amount owed), optionally the rate, optionally plan rows.
- The check, when a full plan is present: the repayment parts add up to the amount owed. Otherwise the recipe is accepted on shape alone and the draft is shown for review as usual.
- A newer plan replaces the debt's plan rows due on or after the new statement's date; earlier rows stay, so past payments keep their split. Undoing that import removes its rows and does not bring the replaced ones back: re-import the older statement if needed (my call).
- Paste box and file drop both work. The owner picks or creates the debt in the draft. Commit and Undo behave like other imports.
- Everything can also be typed by hand on the Debts tab (a balance, a rate): pasting must not be the only way in.

### Where the numbers show

- **Dashboard:** net worth as the headline; under it "Owned" and "Owed".
- **Value over time:** net line by default, and the gross-only chart kept (owner's call). Returns stay computed on investments only.
- **Forecast** (owner's call, option A): investments are forecast as today. A separate "Owed" line runs down by the plan rows (flat at the latest balance when there is no plan), and net = investments minus owed. A note says cash, loan payments and future draws are not modelled. The engine in `src/core/forecast.ts` is not changed; this is an overlay.
- **Weekly summary:** facts gain amount owed, net worth and the change in amount owed.
- **Chat:** a read tool for debts; Confirm cards to add a debt, add a balance, confirm a payment match; a warning-styled card to delete a debt. Debt names pass through `maskAccountNumbers`.
- **Debts tab:** the list, the debt-over-time chart (in `ChartFrame`, so it exports), the plan, and rhythm suggestions waiting for Confirm.

## Order of building (suggested)

1. Tables, amount-owed logic, Debts tab with hand-typed balances, net worth on Dashboard and the two charts.
2. Plan rows, plan matching, the spending split.
3. Rhythm matching for debts and investing, with Confirm.
4. Import recipe and paste for debt statements.
5. Forecast, weekly summary, chat tools and cards.

Each step is useful alone and ends with tests, `tsc` and `oxlint` clean.

## Left to the builder

- Table and column names, file layout (small files, no re-exports, immutable data).
- How a partly matched row is represented.
- The exact recipe schema and verify output, following the bank recipe's pattern.
- Chart styling, within the existing chart palette.

## Open until real data is seen

- The layout of the pasted loan view and the card view.

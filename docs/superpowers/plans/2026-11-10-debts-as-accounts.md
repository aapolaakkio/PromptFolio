# Debts as Accounts, Interest Rates and Closing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A debt becomes a bank account of type `credit` or `loan`; every bank account can carry an interest rate (and a fixed-term one its maturity date) from the browser; accounts can be closed and reopened; interest rates feed an interest-per-year estimate, a Tax page line and the forecast.

**Architecture:** One definition of "debt account" (`DEBT_TYPES` in `src/server/action-inputs.ts`) splits the ledger in `loadPortfolio` into `cashTxns` (money) and `debtTxns` (owed), and every reader takes one of the two. What a debt owes on a day is a pure function in `src/core/owed.ts`: a card from its rows, a loan from the latest stated balance in the new `account_balances` table. The Debts tab and its two tables go; the Cash page shows "Money" and "Owed". Interest and the forecast lines are computed beside the existing engines, which stay unchanged.

**Tech Stack:** TanStack Start (`createServerFn`), Cloudflare D1 with Drizzle (`pnpm db:generate`), zod, React Query, vitest (`renderToStaticMarkup` for component tests, as in `src/web/routes/ProposalCard.test.tsx`), Playwright (`pnpm e2e`, harness in `e2e/harness/`).

**Spec:** `docs/superpowers/specs/2026-11-10-debts-as-accounts-design.md` (approved, including "Calls I made"). It changes `docs/superpowers/specs/2026-11-10-debts-design.md`, step 1 of which was built by `docs/superpowers/plans/2026-11-10-debts-1-tab-and-net-worth.md`.

Five phases, each shippable on its own: 1 account form terms (Task 1), 2 close and reopen (Tasks 2–5), 3 debts as accounts (Tasks 6–11), 4 interest estimate and Tax line (Tasks 12–13), 5 forecast and assistant (Tasks 14–15).

## Global Constraints

- TDD: a failing test first for every behaviour. Run `pnpm test`, `pnpm typecheck`, `pnpm lint` and `pnpm fmt:check` before each commit (the pre-commit hook runs tsc, oxlint and oxfmt, not tests).
- Money is exact: `Money` from `src/core/money.ts` (bigint minor units); formatted strings cross to the client. No floats for stored or summed amounts. The forecast engine already works in numbers (`src/core/forecast.ts`, "a forecast is an estimate"); the new forecast lines follow it and nothing else does.
- Immutable data; files 200–400 lines typical; functions under 50 lines; no re-exports (import from the defining module); no new dependencies; comments rare and short.
- Every server function goes through `authed` (`src/web/server/guard.ts`); input validated by a zod schema in `src/server/action-inputs.ts`; every query filtered by the caller's `userId`; someone else's account answers 404 "Account not found".
- Every new POST server function is listed in `INVENTORY` in `src/web/routes/proposal-inventory.test.ts`, either with the proposal actions whose Confirm calls it or with why it is not offered.
- Schema changes via `pnpm db:generate` only; commit the generated `drizzle/` folder. Never open, migrate or seed the owner's local database (`.wrangler/`), never read `.env`. Tests migrate their own database (`src/server/test-setup.ts`).
- The assistant never writes without a Confirm card. Closing an account uses the warning-styled card (`REMOVALS` in `src/server/chat/proposal-schema.ts`).
- Prompts keep the Finnish context. Interest and tax figures are labelled estimates. The 30 % source-tax rule must be checked on vero.fi by the builder before Task 12 shows it; cite the page URL in a code comment beside `SOURCE_TAX_BP`. If vero.fi does not confirm that deposit interest from a Finnish bank is taxed at source at 30 % and finally, stop and report instead of shipping the figure.
- Tests use fake names and amounts only (e.g. "Visa", "Student loan", "Old savings").
- Browser tests: `pnpm e2e` runs its own servers and databases. Each phase updates the specs it breaks, including `e2e/forecast.spec.ts` and `e2e/tax.spec.ts` (being written by another agent now: build on what is there), and `pnpm e2e` is green before a phase's last commit.
- Work on a branch `debts-as-accounts` cut from `e2e` (Plan's call: `pnpm e2e` needs the harness, which is only on `e2e`). Conventional commits. Never push.
- Phase 3 drops `debts` and `debt_balances` with no data migration (the owner's call). The hand-over of phase 3 says, before the owner runs `pnpm db:migrate:local`, that the Debts-tab entries will be gone and must be added again as accounts.

## Review Focus

1. **An account counted in both cash and owed, or in neither.** Expected: every row of every account is in exactly one of `cashTxns` and `debtTxns`. Pinned in Task 6 (`cash and debt rows split the ledger with nothing left over`).
2. **A card in credit** (a refund or an overpaid bill makes its rows sum positive). Expected: it owes 0, its positive balance counts as owned in net worth, and the Owed group says "In credit". Pinned in Tasks 8 and 9.
3. **Closing an account changes past totals.** Expected: the value series and returns are identical before and after closing; a closed account's rows still count. Pinned in Task 2 (`closing does not change any total`).
4. **Net worth history before "counted from".** Expected: a card owes 0 before its first row and a loan before its first stated balance, and the Dashboard note names each debt account with its date. Pinned in Task 9.
5. **The bank-type lists drifting** (schema enum, `BANK_TYPES` in `action-inputs.ts`, `typesFor("bank")` in `account-type.ts`, the assistant's tool text). Expected: adding `loan` in one place and not another fails a test. Pinned in Task 6 (`the bank types are one list everywhere`).

---

## Phase 1: Account form terms

### Task 1: Interest rate and maturity date in the account form

The server already accepts `interestRate` and `maturityDate` on create and update (`src/server/accounts.ts` `openAccount`, `updateAccount`, `assertTermsMatchType`). Only the browser form is missing them.

**Files:**

- Create: `src/web/routes/account-form.ts`, `src/web/routes/AccountTermsFields.tsx`
- Modify: `src/web/routes/CreateAccountForm.tsx`, `src/web/routes/RenameAccount.tsx` (new props), `src/web/routes/imports.tsx:405` (pass the new props), `src/web/routes/cash.tsx` (an "Edit account" button for the chosen bank account, beside "+ New bank account")
- Test: `src/web/routes/account-form.test.ts`, `src/web/routes/AccountTermsFields.test.tsx`, `e2e/cash.spec.ts`

**Interfaces:**

- Produces:
  - `type TermsForm = { readonly kind: AccountKind; readonly accountType: AccountType | ""; readonly rate: string; readonly maturity: string }`
  - `rateFromBp(bp: number | null): string` (`250` gives `"2.50"`, `null` gives `""`)
  - `termsForCreate(form: TermsForm): { interestRate?: string; maturityDate?: string }`
  - `termsForEdit(form: TermsForm): { interestRate?: string | null; maturityDate?: string | null }` (a bank account always sends both, so switching away from fixed-term clears the stored date and a blank rate clears the rate; a brokerage account sends neither)
  - `AccountTermsFields({ kind, accountType, rate, maturity, onRate, onMaturity })`: "Interest rate %" for `kind === "bank"`, "Maturity date" (`type="date"`) only for `fixed_term`.
  - `RenameAccount` gains props `currentRateBp: number | null` and `currentMaturity: string | null`.

- [ ] **Step 1: Write the failing tests**

```ts
// account-form.test.ts
const bank = (accountType: AccountType | "", rate: string, maturity: string): TermsForm => ({
  kind: "bank",
  accountType,
  rate,
  maturity,
});
test("create sends a typed rate and leaves a blank one out", () => {
  expect(termsForCreate(bank("savings", "2,5", ""))).toEqual({ interestRate: "2,5" });
  expect(termsForCreate(bank("savings", "  ", ""))).toEqual({});
  expect(termsForCreate(bank("fixed_term", "3.10", "2027-01-31"))).toEqual({
    interestRate: "3.10",
    maturityDate: "2027-01-31",
  });
});
test("edit clears a blank rate and a maturity date off a non-fixed-term account", () => {
  expect(termsForEdit(bank("savings", "", "2027-01-31"))).toEqual({
    interestRate: null,
    maturityDate: null,
  });
  expect(termsForEdit(bank("fixed_term", "3.10", "2027-01-31"))).toEqual({
    interestRate: "3.10",
    maturityDate: "2027-01-31",
  });
});
test("a brokerage account sends no terms", () => {
  expect(
    termsForEdit({ kind: "brokerage", accountType: "aot", rate: "2", maturity: "2027-01-31" }),
  ).toEqual({});
});
test("a stored rate shows as the percent the owner types", () => {
  expect(rateFromBp(250)).toBe("2.50");
  expect(rateFromBp(null)).toBe("");
});

// AccountTermsFields.test.tsx (renderToStaticMarkup)
test("a bank account offers a rate, a fixed-term one also a maturity date, a brokerage one neither", () => {
  expect(render("bank", "savings")).toContain("Interest rate %");
  expect(render("bank", "savings")).not.toContain("Maturity date");
  expect(render("bank", "fixed_term")).toContain("Maturity date");
  expect(render("brokerage", "aot")).not.toContain("Interest rate");
});
```

- [ ] **Step 2:** Run `pnpm vitest run src/web/routes/account-form.test.ts src/web/routes/AccountTermsFields.test.tsx`. Expected: FAIL, modules not found.
- [ ] **Step 3:** Implement both files; wire `AccountTermsFields` into both forms (create spreads `termsForCreate`, edit spreads `termsForEdit` into `changes`); on Cash, render `RenameAccount` for the chosen bank account. The edit modal opens with `rateFromBp(currentRateBp)` and `currentMaturity ?? ""`. Server refusals show in the existing `role="alert"`.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5: Browser test** in `e2e/cash.spec.ts`, `a savings rate and a fixed-term maturity are set from the account form`: on Cash create a bank account "Term deposit", type "Savings account", rate `2,5`; record a manual deposit of `100.00` on `2025-03-15`; "Edit account": the rate field shows `2.50`; change type to "Fixed-term account", maturity `2099-12-31`, Save; the row `^Term deposit EUR` shows `Locked until 2099-12-31`; reopening the edit dialog shows maturity `2099-12-31`.
- [ ] **Step 6:** Run `pnpm test && pnpm e2e`. Expected: all pass, including `renaming an account on Imports shows the new name and type on Cash`.
- [ ] **Step 7:** Commit: `feat(accounts): interest rate and maturity date in the account form`.

---

## Phase 2: Close and reopen an account

### Task 2: Closing date and the closing rules

**Files:**

- Modify: `src/server/db/schema.ts` (`accounts.closedOn: text("closed_on")`, nullable, doc comment "The day the owner closed it; rows stay"), `src/server/action-inputs.ts`
- Create: `src/server/account-closing.ts`, migration via `pnpm db:generate`
- Test: `src/server/account-closing.test.ts` (sign-up helper as in `src/server/debts.test.ts`; seed holdings as `seedHolding` in `src/server/views/portfolio.test.ts` does)

**Interfaces:**

- Produces:
  - `CloseAccountInput = z.object({ id: positive int, closedOn: IsoDate (real calendar date) }).strict()`; `ReopenAccountInput = z.object({ id: positive int }).strict()`
  - `whatRemains(db: Db, userId: string, accountId: number, on: IsoDate): Promise<readonly string[]>`: one item per kind of thing left, in this order and wording: `cash 120.50 EUR` (one per non-zero currency, from `cashBalancesAt` over the account's own rows), `holdings ACME Oyj, Other Fund` (names of non-zero positions from `positionsAt`, no quantities). Task 9 adds `owed 40.00 EUR`.
  - `closeOwnedAccount(db, userId, input: z.infer<typeof CloseAccountInput>): Promise<void>`
  - `reopenOwnedAccount(db, userId, input: z.infer<typeof ReopenAccountInput>): Promise<void>`
  - `refusalText(name: string, on: IsoDate, remains: readonly string[]): string` = `` `Cannot close ${name} on ${on}: it still holds ${remains.join("; ")}.` ``

Plan's call: the closing date may not be after today (Helsinki, `helsinkiToday` in `src/server/summary/helsinki.ts`) nor before the account's latest row, so a closed account never has rows after its closing date when it closes.

- [ ] **Step 1: Write the failing tests**

```ts
test("an empty account closes on the given date and keeps its rows", async () => {
  // bank "Old savings": DEPOSIT 100.00 on 2026-01-10, WITHDRAWAL 100.00 on 2026-02-01
  await closeOwnedAccount(db, userId, { id, closedOn: "2026-03-01" });
  expect((await accountRow(id)).closedOn).toBe("2026-03-01");
  expect(await rowCount(id)).toBe(2);
});
test("closing is refused while money is left, naming it", async () => {
  // DEPOSIT 120.50 on 2026-01-10
  await expect(closeOwnedAccount(db, userId, { id, closedOn: "2026-03-01" })).rejects.toMatchObject(
    {
      status: 400,
      message: "Cannot close Old savings on 2026-03-01: it still holds cash 120.50 EUR.",
    },
  );
});
test("closing is refused while holdings are left, naming them", async () => {
  // brokerage "Nordnet AOT" holding ACME Oyj
  await expect(close(brokerageId, "2026-03-01")).rejects.toMatchObject({
    status: 400,
    message: expect.stringContaining("holdings ACME Oyj"),
  });
});
test("a future date, a date before the last row and a second close are refused", async () => {
  await expect(close(id, "2999-01-01")).rejects.toMatchObject({
    status: 400,
    message: "An account cannot be closed in the future",
  });
  await expect(close(id, "2026-01-15")).rejects.toMatchObject({
    status: 400,
    message: "Old savings has a transaction on 2026-02-01, after the closing date",
  });
  await close(id, "2026-03-01");
  await expect(close(id, "2026-03-02")).rejects.toMatchObject({
    status: 400,
    message: "Old savings is already closed",
  });
});
test("reopening clears the closing date; an open account cannot be reopened", async () => {
  await reopenOwnedAccount(db, userId, { id });
  expect((await accountRow(id)).closedOn).toBeNull();
  await expect(reopenOwnedAccount(db, userId, { id })).rejects.toMatchObject({
    status: 400,
    message: "Old savings is not closed",
  });
});
test("someone else's account answers 404 and stays open", async () => {
  await expect(closeOwnedAccount(db, other, { id, closedOn: "2026-03-01" })).rejects.toMatchObject({
    status: 404,
  });
  expect((await accountRow(id)).closedOn).toBeNull();
});
test("closing does not change any total", async () => {
  // a holding plus the emptied bank account
  const seriesBefore = await valueSeriesView(db, userId, "2026-01-01", "2026-03-05");
  const returnsBefore = await returnsView(db, userId, "2026-01-01", "2026-03-05");
  await close(id, "2026-03-01");
  expect(await valueSeriesView(db, userId, "2026-01-01", "2026-03-05")).toEqual(seriesBefore);
  expect(await returnsView(db, userId, "2026-01-01", "2026-03-05")).toEqual(returnsBefore);
});
```

- [ ] **Step 2:** Run `pnpm vitest run src/server/account-closing.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Add the column, run `pnpm db:generate` (expected: one migration adding `closed_on` to `accounts`, nothing else), add the schemas, implement `account-closing.ts` with `assertAccountOwned` first and `loadPortfolio`'s `txns` filtered to the account. Do not filter closed accounts out of `loadPortfolio`.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(accounts): close and reopen an account, refused while it holds anything`.

### Task 3: Closed accounts leave the lists

**Files:**

- Modify: `src/server/accounts.ts` (add `listOpenAccounts`), `src/server/chat/tools-records.ts` (`get_accounts` uses it), `src/server/import/sort-service.ts:103` (uses it), `src/server/valuation.ts` (`CashView` gains `closedOn: string | null`, filled in `cashFor`)
- Create: `src/web/routes/account-list.ts`
- Modify: `src/web/routes/cash.tsx`, `src/web/routes/imports.tsx`, `src/web/routes/reconcile.tsx` (pickers use `openAccounts`)
- Test: `src/server/accounts.test.ts`, `src/server/chat/tools-records.test.ts`, `src/server/import/sort-service.test.ts`, `src/server/valuation.test.ts`, `src/web/routes/account-list.test.ts`

**Interfaces:**

- Produces:
  - `listOpenAccounts(db: Db, userId: string)` (same row type as `listAccounts`, `closedOn === null` only). `listAccounts` keeps returning every account, now with `closedOn`; `proposal-kit.ts` `ownAccount`, `page-line.ts` and `proposals.ts` keep using it (names and reopen need closed ones).
  - `openAccounts<T extends { closedOn: string | null }>(list: readonly T[]): T[]` and `closedAccounts<T ...>(list): T[]` (newest closing first).

Plan's call: a closed account with a non-zero balance today (rows imported after it closed) still shows on Cash, labelled "Closed <date>", so the rows shown always add up to the totals.

- [ ] **Step 1: Write the failing tests:** `listOpenAccounts leaves out closed accounts; listAccounts keeps them with closedOn`; in `tools-records.test.ts` `get_accounts leaves out a closed account`; in `sort-service.test.ts` `a closed account is never suggested for a file`; in `valuation.test.ts` `a closed account with money today still shows, with its closing date` (insert a DEPOSIT dated after `closedOn` directly; `cashFor(...).rows[0].closedOn` equals it); `account-list.test.ts`: `openAccounts([{id:1,closedOn:null},{id:2,closedOn:"2026-03-01"}])` gives id 1, `closedAccounts` gives id 2.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement. On Cash, the closed label goes into the Availability cell: `Closed ${formatDate(closedOn)}`.
- [ ] **Step 4:** Run `pnpm test`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(accounts): closed accounts leave Cash, the pickers and the assistant's list`.

### Task 4: Server functions and assistant Confirm cards

**Files:**

- Modify: `src/web/server/accounts.ts` (`closeAccount`, `reopenAccount`), `src/server/chat/proposals-accounts.ts`, `src/server/chat/proposal-schema.ts` (union, `ACTION_NAMES`, `REMOVALS`), `src/web/routes/proposal-actions.ts` (`formActions`), `src/web/routes/proposal-inventory.test.ts` (`closeAccount: ["close_account"]`, `reopenAccount: ["reopen_account"]`), `src/server/chat/runner.ts` (rule 10)
- Test: `src/server/chat/proposals-accounts.test.ts`, `src/server/chat/runner.test.ts`, `src/web/routes/proposal-inventory.test.ts`

**Interfaces:**

- Consumes: Task 2 schemas, `whatRemains`, `refusalText`.
- Produces: POST server functions `closeAccount` (validator `CloseAccountInput`) and `reopenAccount` (`ReopenAccountInput`), each `readable(() => ...)`. Proposal tools `propose_close_account` and `propose_reopen_account` in the `ACCOUNTS` area; actions `close_account`, `reopen_account`. `REMOVALS` gains `["close_account", { button: "Close account", after: "Reopen it from Closed accounts on the Cash page." }]`.

- [ ] **Step 1: Write the failing tests**

```ts
describe("propose_close_account", () => {
  test("names the account and date, says the rows stay, and closes nothing yet", async () => {
    const proposal = await run("propose_close_account", { id, closedOn: "2026-03-01" });
    expect(proposal.action).toBe("close_account");
    expect(proposal.facts).toContainEqual({
      kind: "text",
      label: "Closing date",
      text: "2026-03-01",
    });
    expect(proposal.facts).toContainEqual({
      kind: "text",
      label: "Kept",
      text: "Its transactions stay in history, Spending and Tax",
    });
    expect((await accountRow(id)).closedOn).toBeNull();
    expect(confirmLabel("close_account")).toBe("Close account");
  });
  test("an account that still holds money is refused with the form's message", async () => {
    await expect(
      run("propose_close_account", { id: funded, closedOn: "2026-03-01" }),
    ).rejects.toThrow("Cannot close Old savings on 2026-03-01: it still holds cash 120.50 EUR.");
  });
});
describe("propose_reopen_account", () => {
  test("a closed account can be proposed for reopening; an open one is refused", async () => {
    /* ... */
  });
});
// runner.test.ts
test("the prompt points to closing an account instead of saying none can be removed", () => {
  expect(SYSTEM_PROMPT).toContain("propose_close_account");
  expect(SYSTEM_PROMPT).not.toContain(
    "deleting an account or the whole ledger (the app has no such feature)",
  );
});
```

- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement. Rule 10's list item becomes: "deleting an account or the whole ledger (the app has none; an account no longer in use can be closed with propose_close_account, and only while it holds nothing)". The close card's check uses the same `whatRemains` as the server, and Confirm runs the server function, which checks again.
- [ ] **Step 4:** Run `pnpm test`. Expected: PASS, including both inventory tests.
- [ ] **Step 5:** Commit: `feat(chat): the assistant can propose closing and reopening an account`.

### Task 5: Close and reopen in the browser

**Files:**

- Modify: `src/web/routes/RenameAccount.tsx` (a "Close account" part), `src/web/routes/cash.tsx` (a "Closed accounts" card at the bottom)
- Create: `src/web/routes/ClosedAccounts.tsx`
- Test: `src/web/routes/ClosedAccounts.test.tsx`, `e2e/cash.spec.ts`

**Interfaces:**

- Consumes: `closeAccount`, `reopenAccount`, `closedAccounts`.
- Produces: `ClosedAccounts({ accounts, onReopen })`: renders nothing when empty; otherwise one row per account: name, `accountTypeLabel`, `closed <formatDate>`, a button `Reopen <name>`.

- [ ] **Step 1: Write the failing test:** `ClosedAccounts` with `[]` renders `""`; with one account "Old savings" closed `2025-04-01` contains `Closed accounts`, `closed 01/04/2025` and `Reopen Old savings`.
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Implement. In the edit dialog: a "Closing date" date input (default today, `max` today) and a "Close account" button opening the existing `Modal` with "Close <name> on <date>? It leaves Cash, the account pickers and the assistant's list. Its transactions stay." and buttons "Close account" / "Cancel". The server's refusal shows in the dialog's `role="alert"`. On success invalidate `["accounts"]`, `["cash"]`, `["returns"]`. Cash lists closed accounts from `getAccounts()` through `closedAccounts`.
- [ ] **Step 4:** Run the test. Expected: PASS.
- [ ] **Step 5: Browser test** `closing is refused while money is left, and an empty account closes and reopens`: create "Old savings", record DEPOSIT `100.00` on `2025-03-15`; Edit account, closing date `2025-04-01`, Close account, confirm: alert `Cannot close Old savings on 2025-04-01: it still holds cash 100.00 EUR.`; record WITHDRAWAL `100.00` on `2025-03-20`; close again: the dialog closes, the "Bank account" picker no longer contains "Old savings", "Closed accounts" shows `closed 01/04/2025`; "Reopen Old savings": the picker contains it again and the card is gone.
- [ ] **Step 6:** Run `pnpm test && pnpm e2e`. Expected: all pass.
- [ ] **Step 7:** Commit: `feat(accounts): close an account from its form and reopen it from Cash`.

---

## Phase 3: Debts as accounts

### Task 6: The `loan` type and one account set

**Files:**

- Modify: `src/server/action-inputs.ts` (`BANK_TYPES` gains `"loan"`; new `DEBT_TYPES`, `isDebtType`, `isMoneyAccount`; replace the comment on line 148), `src/server/db/schema.ts:85` (enum gains `"loan"`), `src/web/routes/account-type.ts` (`{ id: "loan", label: "Loan" }`), `src/server/chat/proposals-accounts.ts` (the two descriptions build the type list from `BROKERAGE_TYPES` and `BANK_TYPES` instead of literal text), `src/server/valuation.ts` (`loadPortfolio`)
- Create: migration via `pnpm db:generate` (expected: none or an empty one; SQLite text enums carry no CHECK. If drizzle generates nothing, nothing is committed.)
- Test: `src/web/routes/account-type.test.ts`, `src/server/valuation.test.ts`, `src/server/accounts.test.ts`, `src/server/chat/proposals-accounts.test.ts`

**Interfaces:**

- Produces:
  - `DEBT_TYPES = ["credit", "loan"] as const`; `isDebtType(type: string | null): type is "credit" | "loan"`; `isMoneyAccount(account: { kind: string; accountType: string | null }): boolean` (bank kind and not a debt type)
  - `Portfolio` gains `debtTxns: readonly Txn[]` (rows of credit and loan accounts) and `debtAccounts: readonly { id: number; type: "credit" | "loan"; currency: Currency; name: string }[]`; `cashTxns` becomes `txns` minus every debt account's rows (was: minus credit only). One `accounts` query in `loadPortfolio` replaces the two it has today for credit and bank ids.

- [ ] **Step 1: Write the failing tests**

```ts
// account-type.test.ts
test("the bank types are one list everywhere", () => {
  const sorted = (list: readonly string[]) => [...list].sort();
  expect(typesFor("bank").map((type) => type.id)).toEqual([...BANK_TYPES]);
  expect(sorted(accounts.accountType.enumValues)).toEqual(
    sorted([...BROKERAGE_TYPES, ...BANK_TYPES]),
  );
  expect(DEBT_TYPES.every((type) => BANK_TYPES.includes(type))).toBe(true);
  expect(accountTypeLabel("loan")).toBe("Loan");
});
// proposals-accounts.test.ts
test("the tool text names every bank type", () => {
  for (const type of BANK_TYPES) expect(createTool.description).toContain(type);
});
// valuation.test.ts
test("cash and debt rows split the ledger with nothing left over", async () => {
  // one bank account per BANK_TYPES entry, plus an untyped bank and an "aot" brokerage, each with one DEPOSIT
  const { txns, cashTxns, debtTxns } = await loadPortfolio(db, userId);
  const ids = (list: readonly Txn[]) => new Set(list.map((txn) => txn.id));
  expect(ids(cashTxns).size + ids(debtTxns).size).toBe(txns.length);
  expect([...ids(cashTxns)].some((id) => ids(debtTxns).has(id))).toBe(false);
  expect(debtTxns.map((txn) => txn.accountId).sort()).toEqual([creditId, loanId].sort());
});
// accounts.test.ts
test("a loan takes a rate but no maturity date", async () => {
  const loan = await openAccount(db, userId, {
    ...bankBody,
    accountType: "loan",
    interestRate: "4.25",
  });
  expect(loan.interestRateBp).toBe(425);
  await expect(
    openAccount(db, userId, { ...bankBody, accountType: "loan", maturityDate: "2030-01-01" }),
  ).rejects.toMatchObject({
    status: 400,
    message: "A maturity date applies only to fixed-term accounts",
  });
});
```

- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement. Check that drizzle 1.0's sqlite text column exposes `enumValues`; if not, export the enum array from `schema.ts` and test that instead.
- [ ] **Step 4:** Run `pnpm test`. Expected: PASS, every existing `cashTxns` test unchanged.
- [ ] **Step 5:** Commit: `feat(accounts): a loan type, and debt accounts kept out of cash in one place`.

### Task 7: Stated balances and a card's opening amount owed

**Files:**

- Modify: `src/server/db/schema.ts` (append `accountBalances`), `src/server/action-inputs.ts`, `src/server/spending/internal.ts` (`internalTransferIds` skips `OPENING_BALANCE` rows)
- Create: `src/server/account-balances.ts`, migration via `pnpm db:generate`
- Test: `src/server/account-balances.test.ts`, `src/server/spending/cashflow.test.ts`

**Interfaces:**

- Produces:
  - Table `accountBalances` (`account_balances`): `id`, `accountId` → `accounts.id` on delete cascade, `asOf` text, `owedMinor` integer (account currency), `source` enum `import | manual` default `manual`, `importId` nullable → `imports.id`; unique (`accountId`, `asOf`); check `owed_minor >= 0`.
  - `OwedBalanceInput = { accountId, asOf (real date), owed: /^\d{1,12}([.,]\d{1,2})?$/ }`; `OwedBalanceRemoveInput = { accountId, asOf }`; `OpeningOwedInput = { accountId, on (real date), owed }` (all `.strict()`)
  - `type StatedBalance = { readonly accountId: number; readonly asOf: IsoDate; readonly owed: Money }` (defined in `src/core/owed.ts`, Task 8; write that type first)
  - `setOwedBalance(db, userId, input): Promise<void>` (upsert on (`accountId`, `asOf`), source `manual`)
  - `removeOwedBalance(db, userId, input): Promise<void>`
  - `statedBalancesFor(db, userId): Promise<StatedBalance[]>`
  - `setOpeningOwed(db, userId, input): Promise<void>`: writes the card's `OPENING_BALANCE` as `-owed` dated `on` in the account currency, replacing the card's earlier opening balance in that currency.

Plan's call: a stated balance on a card that already has rows is refused rather than stored and ignored, so the owner is never shown a figure that does not count. Stored ones made before rows arrived stay and are ignored (Task 8).

- [ ] **Step 1: Write the failing tests**

```ts
test("a loan's balance is stored in its own currency, and a second one that day replaces the first", async () => {
  await setOwedBalance(db, userId, { accountId: sekLoan, asOf: "2026-01-10", owed: "1000" });
  await setOwedBalance(db, userId, { accountId: sekLoan, asOf: "2026-01-10", owed: "750,50" });
  expect(await statedBalancesFor(db, userId)).toEqual([
    { accountId: sekLoan, asOf: "2026-01-10", owed: { minor: 750_50n, currency: "SEK" } },
  ]);
});
test("refused: a money account, a card with rows, a future date, someone else's account", async () => {
  await expect(set(savingsId, "2026-01-10", "1")).rejects.toMatchObject({
    status: 400,
    message: "Only a loan or credit card account has a balance owed",
  });
  await expect(set(cardWithRows, "2026-01-10", "1")).rejects.toMatchObject({
    status: 400,
    message: "Visa's balance comes from its imported rows",
  });
  await expect(set(loanId, "2999-01-01", "1")).rejects.toMatchObject({
    status: 400,
    message: "A balance cannot be dated in the future",
  });
  await expect(
    setOwedBalance(db, other, { accountId: loanId, asOf: "2026-01-10", owed: "1" }),
  ).rejects.toMatchObject({ status: 404 });
});
test("a card's opening amount owed is a negative opening balance, replaced when set again", async () => {
  await setOpeningOwed(db, userId, { accountId: cardId, on: "2026-01-01", owed: "1200.00" });
  await setOpeningOwed(db, userId, { accountId: cardId, on: "2026-01-01", owed: "1100.00" });
  expect(await openingRows(cardId)).toEqual([{ tradeDate: "2026-01-01", amount: -110_000 }]);
  await expect(
    setOpeningOwed(db, userId, { accountId: loanId, on: "2026-01-01", owed: "1" }),
  ).rejects.toMatchObject({
    status: 400,
    message: "An opening amount owed applies only to credit cards",
  });
});
test("deleting the account deletes its stated balances", async () => {
  /* cascade */
});
// cashflow.test.ts
test("an opening balance is never paired as an own transfer", () => {
  // card OPENING_BALANCE -1200.00 on 2026-01-01, current account DEPOSIT +1200.00 on 2026-01-02
  expect(internalTransferIds(txns).size).toBe(0);
});
```

- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement. Amounts parse with `parseMoney(text, account.baseCurrency)`; "today" is `helsinkiToday(new Date())`; errors are `HttpError`.
- [ ] **Step 4:** Run `pnpm test`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(debts): stated balances for loans and a card's opening amount owed`.

### Task 8: What a debt owes on a day (pure)

**Files:**

- Create: `src/core/owed.ts`
- Test: `src/core/owed.test.ts`

**Interfaces:**

- Produces:
  - `type DebtType = "credit" | "loan"`; `type DebtAccount = { readonly id: number; readonly type: DebtType; readonly currency: Currency }`; `type StatedBalance` (above)
  - `type DebtPosition = { readonly accountId: number; readonly currency: Currency; readonly owed: Money; readonly inCredit: Money; readonly source: "rows" | "stated" | "none" }`
  - `debtPositionsAt(accounts: readonly DebtAccount[], txns: readonly Txn[], stated: readonly StatedBalance[], on: IsoDate): DebtPosition[]`: a card with any row up to `on` sums its rows per currency like `cashBalancesAt` (`owed = max(0, -sum)`, `inCredit = max(0, sum)`, source `rows`); a card without rows and every loan take the latest stated balance on or before `on` (source `stated`); loan rows are ignored; nothing known gives zeros and `none`.
  - `owedSeries(accounts, txns, stated, fxOn: (currency: Currency, on: IsoDate) => FxRate | null, from: IsoDate, to: IsoDate): { date: IsoDate; owedEur: Money; inCreditEur: Money }[]` (one point per day as `datesBetween`; a currency without a rate that day is left out, as `cashSeries` does; one pass, not `debtPositionsAt` per day)
  - `countedFrom(accounts, txns, stated): ReadonlyMap<number, IsoDate>` (a card's first row, else its first stated balance; a loan's first stated balance; accounts with neither are absent)

- [ ] **Step 1: Write the failing tests**

```ts
const eur = (minor: bigint) => ({ minor, currency: EUR });
const card: DebtAccount = { id: 1, type: "credit", currency: EUR };
const loan: DebtAccount = { id: 2, type: "loan", currency: EUR };
// card rows: OPENING_BALANCE -1200.00 on 2026-01-01, WITHDRAWAL -300.00 on 2026-01-05, DEPOSIT +1500.00 on 2026-01-20, DEPOSIT +80.00 on 2026-01-25
// loan stated: 5000.00 on 2026-01-10, 4800.00 on 2026-02-10; one loan row WITHDRAWAL -99.00 on 2026-01-15

test("a card owes minus the sum of its rows", () => {
  const [position] = debtPositionsAt([card], txns, [], "2026-01-05");
  expect(position).toMatchObject({ owed: eur(1_500_00n), inCredit: eur(0n), source: "rows" });
});
test("a card in credit owes nothing and is money owned", () => {
  const [position] = debtPositionsAt([card], txns, [], "2026-01-25");
  expect(position).toMatchObject({ owed: eur(0n), inCredit: eur(80_00n) });
});
test("a loan is its latest stated balance; its rows change nothing", () => {
  expect(debtPositionsAt([loan], txns, stated, "2026-02-09")[0]?.owed).toEqual(eur(5_000_00n));
  expect(debtPositionsAt([loan], txns, stated, "2026-02-10")[0]?.owed).toEqual(eur(4_800_00n));
});
test("a card without rows takes a stated balance; once it has rows the rows win", () => {
  const typed = [{ accountId: 1, asOf: "2025-12-01", owed: eur(999_00n) }];
  expect(debtPositionsAt([card], [], typed, "2025-12-31")[0]).toMatchObject({
    owed: eur(999_00n),
    source: "stated",
  });
  expect(debtPositionsAt([card], txns, typed, "2026-01-01")[0]).toMatchObject({
    owed: eur(1_200_00n),
    source: "rows",
  });
});
test("before it is counted a debt owes nothing", () => {
  expect(
    debtPositionsAt([card, loan], txns, stated, "2025-12-31").every((p) => p.owed.minor === 0n),
  ).toBe(true);
  expect(countedFrom([card, loan], txns, stated)).toEqual(
    new Map([
      [1, "2026-01-01"],
      [2, "2026-01-10"],
    ]),
  );
});
test("the series is one point per day and converts another currency at that day's rate", () => {
  const series = owedSeries([card, loan], txns, stated, noFx, "2026-01-09", "2026-01-10");
  expect(series.map((p) => p.owedEur.minor)).toEqual([1_500_00n, 6_500_00n]);
  // a SEK loan of 1000.00 SEK at 0.09 EUR per SEK owes 90.00 EUR; with no rate it is left out
});
```

- [ ] **Step 2:** Run `pnpm vitest run src/core/owed.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Reuse `CASH_MOVING` semantics by calling `cashBalancesAt` on the card's own rows for `debtPositionsAt`; the series walks sorted rows and balances once.
- [ ] **Step 4:** Run the test. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(debts): what a card or loan owes on a day`.

### Task 9: Owed report and net worth from accounts

**Files:**

- Create: `src/server/owed.ts`
- Modify: `src/server/views/portfolio.ts` (`valueSeriesView`, `returnsView`: owed from `src/server/owed.ts`, no longer from `../debts.ts`), `src/server/account-closing.ts` (`whatRemains` adds `owed 40.00 EUR` for a debt account, and a card's row sum no longer reads as cash), `src/web/routes/dashboard.tsx` (the note)
- Test: `src/server/owed.test.ts`, `src/server/views/portfolio.test.ts` (rewrite `describe("owed and net worth")` on accounts), `src/server/account-closing.test.ts`

**Interfaces:**

- Consumes: `loadPortfolio().debtAccounts/debtTxns/prices.fxOn`, `statedBalancesFor`, Task 8.
- Produces:
  - `owedFor(db, userId, on: IsoDate): Promise<OwedReport>`; `OwedReport = { rows: OwedRow[]; owedEur: string; inCreditEur: string }`; `OwedRow = { accountId, accountName, type: DebtType, currency, owed: string, inCredit: string, owedEur: string | null, source: "rows" | "stated" | "none", latestRowDate: string | null, countedFrom: string | null, stated: { asOf: string; owed: string; source: "import" | "manual" }[] (newest first), closedOn: string | null }`. Rows of closed accounts that owe nothing are left out, as cash does.
  - `owedSeriesFor(db, userId, from, to)` (the Task 8 series for the caller)
  - Each `valueSeriesView` point: `owedEur`, `netEur = valueEur + cashEur + inCreditEur − owedEur` (field names kept).
  - `returnsView` gains `inCreditEur`, `ownedEur` (`valueWithCashEur + inCreditEur`) and `debtsCountedFrom: readonly { accountName: string; from: string }[]` (oldest first); `netWorthEur = ownedEur − owedEur`. `debtsKnownFrom` is removed.

- [ ] **Step 1: Write the failing tests** (in `portfolio.test.ts`, replacing the four `addDebt` tests, same values):

```ts
test("value series: a loan's stated balance counts from its day on", async () => {
  await seedThousand(userId);
  await owedLoan(userId, "2024-01-03", "300.00"); // loan account + setOwedBalance
  const body = await valueSeriesView(db, userId, "2024-01-01", "2024-01-05");
  expect(body.map((p) => [p.owedEur, p.netEur])).toEqual([
    ["0.00", "1000.00"],
    ["0.00", "1000.00"],
    ["300.00", "700.00"],
    ["300.00", "700.00"],
    ["300.00", "700.00"],
  ]);
});
test("a card purchase is owed and its bill payment moves nothing in net worth", async () => {
  // current account OPENING_BALANCE +500.00 on 2024-01-01; card WITHDRAWAL -120.00 on 2024-01-02;
  // current WITHDRAWAL -120.00 and card DEPOSIT +120.00 on 2024-01-04
  const net = (await valueSeriesView(db, userId, "2024-01-01", "2024-01-05")).map((p) => p.netEur);
  expect(net).toEqual(["500.00", "380.00", "380.00", "380.00", "380.00"]);
});
test("a card in credit adds to what is owned", async () => {
  // card DEPOSIT +80.00 only
  const returns = await returnsView(db, userId, "2024-01-01", "2024-01-05");
  expect([returns.owedEur, returns.inCreditEur, returns.netWorthEur]).toEqual([
    "0.00",
    "80.00",
    "1080.00",
  ]);
});
test("returns: net worth is owned minus owed, twr and mwr unchanged, each debt named with its date", async () => {
  // as the existing test, plus a card whose first row is 2024-01-04
  expect(after.netWorthEur).toBe("800.00");
  expect(after.debtsCountedFrom).toEqual([
    { accountName: "Loan", from: "2024-01-03" },
    { accountName: "Visa", from: "2024-01-04" },
  ]);
  expect(after.twr).toBe(before.twr);
});
test("no debts: nothing owed, net worth equals value with cash", async () => {
  expect(returns.debtsCountedFrom).toEqual([]);
});
test("net worth can be negative and prints a leading minus", async () => {
  /* loan 1500.00: "-500.00" */
});
// owed.test.ts
test("the Owed report lists each debt account with its source and latest row", async () => {
  expect(report.rows.find((row) => row.accountName === "Visa")).toMatchObject({
    owed: "120.00",
    owedEur: "120.00",
    source: "rows",
    latestRowDate: "2024-01-02",
    countedFrom: "2024-01-02",
  });
  expect(report.owedEur).toBe("420.00");
});
// account-closing.test.ts
test("a card or loan that still owes cannot be closed", async () => {
  await expect(close(cardId, "2026-03-01")).rejects.toMatchObject({
    message: "Cannot close Visa on 2026-03-01: it still holds owed 40.00 EUR.",
  });
});
```

- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement. Dashboard: the Net worth note becomes `owned ${eur(ownedEur)} − owed ${eur(owedEur)}`; under the net chart, when `debtsCountedFrom` is non-empty: "Debts are counted from: Visa 04/01/2024, Loan 03/01/2024. Before its date a debt counts as zero." (dates through `formatDate`). Remove every use of `debtBalancesFor`, `owedOn`, `firstBalanceDate` from `portfolio.ts`.
- [ ] **Step 4:** Run `pnpm test`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(debts): net worth from card and loan accounts`.

### Task 10: Cash page "Money" and "Owed", and owed fields in the account form

**Files:**

- Create: `src/web/server/owed.ts`, `src/web/routes/OwedGroup.tsx`, `src/web/routes/OwedFields.tsx`, `src/web/routes/owed-view.ts`
- Modify: `src/web/routes/cash.tsx`, `src/web/routes/CreateAccountForm.tsx`, `src/web/routes/RenameAccount.tsx`, `src/web/routes/proposal-inventory.test.ts`
- Test: `src/web/routes/owed-view.test.ts`, `src/web/routes/OwedGroup.test.tsx`

**Interfaces:**

- Consumes: `owedFor`, `setOwedBalance`, `removeOwedBalance`, `setOpeningOwed` and their schemas.
- Produces:
  - `getOwed` (GET, input `{ on?: IsoDate }`), POST `saveOwedBalance`, `deleteOwedBalance`, `saveOpeningOwed`. Inventory entries: `"not offered: typed in the account form on the Cash page"` for all three (Plan's call: the design gives the assistant reads, not these writes; `propose_account_balance` already covers a card's balance).
  - `sourceText(row: OwedRow): string`: `rows` gives `From imported rows, latest 02/01/2024`; `stated` gives `Stated balance of 03/01/2024`; `none` gives `No balance yet`.
  - `OwedGroup({ report })`: heading "Owed", total `Owed in total`, a row per account (name, type label, owed, EUR, `sourceText`), `In credit €80.00` when `inCredit !== "0.00"`, and for a card with source `rows` and no opening balance the line "Without the amount owed when the first statement begins, this card shows too little owed."
  - `OwedFields({ type, accountId })` in the forms: for `loan` and `credit` "Balance owed on a date" (date, amount, Save, and the stated balances with "Remove the balance of <date>" buttons); for `credit` also "Owed when the first imported statement begins" (date defaulting to the card's first row, amount).

Plan's call: Cash keeps one page; the existing table becomes the "Money" group with its total relabelled "Money in total", and "Reconcile balance" and "Manual entries" are hidden for a `loan` (its value is stated balances only). In the create form, owed fields save after the account is created, in a second call whose failure is shown without undoing the account.

- [ ] **Step 1: Write the failing tests:** `sourceText` for each source with the strings above; `OwedGroup` rendered with no rows contains `No debts. Add a loan or credit card as a bank account.`; with a card in credit contains `In credit €80.00`; with a card lacking an opening balance contains `shows too little owed`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement. Every write invalidates `["owed"]`, `["cash"]`, `["returns"]` and the Dashboard series key.
- [ ] **Step 4:** Run `pnpm test`. Expected: PASS, including the inventory.
- [ ] **Step 5:** Commit: `feat(debts): Money and Owed on the Cash page, owed amounts in the account form`.

### Task 11: Remove the Debts tab and its tables; browser tests

**Files:**

- Delete: `src/server/debts.ts`, `src/server/debts.test.ts`, `src/core/debts.ts`, `src/core/debts.test.ts`, `src/web/server/debts.ts`, `src/web/routes/debts.tsx`, `src/web/routes/debts-view.ts`, `src/web/routes/debts-view.test.ts`, `src/web/app/_authenticated/debts.tsx`
- Modify: `src/server/db/schema.ts` (remove `debts`, `debtBalances`), `src/server/action-inputs.ts` (remove `DebtInput`, `DebtBalanceInput`, `DebtBalanceRemoveInput` and constants only they use), `src/web/routes/session-gate.tsx` (nav link), `src/server/chat/page-context.ts`, `src/server/chat/page-line.ts`, `src/web/routes/starters.ts` (`debts` key), `src/web/app/routes.test.ts`, `src/web/routes/proposal-inventory.test.ts` (four debt entries), `src/server/chat/runner.ts` (rule 1), `src/web/routeTree.gen.ts` (regenerated), `README.md` (the Debts line becomes debts as bank accounts on Cash)
- Create: migration via `pnpm db:generate` (expected: drops exactly `debt_balances` and `debts`)
- Rewrite: `e2e/debts.spec.ts`; Modify: `e2e/harness.spec.ts`, `e2e/isolation.spec.ts`, `e2e/smoke.spec.ts` (remove "Debts" from `PAGES`)
- Test: `src/server/chat/runner.test.ts`, `src/server/chat/page-line.test.ts`

Plan's call: rule 1 keeps saying the assistant cannot see debts until Task 15, but points to the Cash page's Owed group instead of the Debts page, so no phase ships a prompt naming a page that is gone.

- [ ] **Step 1: Write the failing tests:** `runner.test.ts` `the prompt names no Debts page`: `expect(SYSTEM_PROMPT).not.toContain("Debts page")` and `toContain("Owed group on the Cash page")`; `page-line.test.ts`: `PageContext.safeParse({ page: "debts" }).success` is `false`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Delete and edit as listed; run `pnpm db:generate`; regenerate the route tree (`pnpm build` or `pnpm dev`, whichever this repo uses to write `routeTree.gen.ts`) and confirm `grep -rn "debt_balances\|DebtInput\|/debts" src` finds only the new migration.
- [ ] **Step 4:** Run `pnpm test && pnpm typecheck`. Expected: clean.
- [ ] **Step 5: Rewrite `e2e/debts.spec.ts`** against Cash and the account form (fixed past dates, fake names):
  - `a loan and a credit card are bank accounts, listed under Owed`: create "Student loan" (type Loan, rate `2,5`) and "Visa" (Credit card); both appear in the Owed group with `No balance yet`; neither appears in the Money group.
  - `Owed in total follows a loan's latest stated balance`: balances `1000` on `2025-01-15`, `800` on `2025-03-01`, `900` on `2025-02-01`: total `€800.00`, row shows `Stated balance of 01/03/2025`; removing the `01/03/2025` balance gives `€1,000.00`.
  - `a card's purchases are owed and its opening amount counts`: on Visa record WITHDRAWAL `120.00` on `2025-02-10` (Manual entries); Owed shows `€120.00` and the "too little owed" line; set "Owed when the first imported statement begins" `500` on `2025-02-01`: `€620.00`, the line is gone.
  - `the server refuses a balance dated in the future with its own message` (as today, on the loan's form).
  - `the Dashboard shows Net worth only with a debt` (as today's last test, with a loan account: `owned €1,875.09 − owed €500.00`).
  - `a loan that still owes cannot be closed`: alert `Cannot close Student loan on <date>: it still holds owed 500.00 EUR.`
  - `harness.spec.ts` and `isolation.spec.ts`: the per-user write becomes creating a loan account on Cash; user B sees `No debts.` in the Owed group.
- [ ] **Step 6:** Run `pnpm e2e`. Expected: all pass.
- [ ] **Step 7:** Commit: `feat(debts)!: the Debts tab and its tables give way to loan and card accounts`.

---

## Phase 4: Interest estimate and the Tax line

### Task 12: Interest per year on Cash

**Files:**

- Create: `src/core/interest.ts`, `src/server/interest.ts`
- Modify: `src/web/server/portfolio.ts` (GET `getInterest`, input `{ on?: IsoDate }`), `src/web/routes/cash.tsx`, `src/web/routes/OwedGroup.tsx`
- Test: `src/core/interest.test.ts`, `src/server/interest.test.ts`, `e2e/cash.spec.ts`

**Interfaces:**

- Produces:
  - `SOURCE_TAX_BP = 3000` (with the vero.fi URL comment)
  - `yearlyInterest(amount: Money, rateBp: number, on: IsoDate, maturity: IsoDate | null): Money | null`: `amount × rateBp / 10 000`, prorated by days `on → maturity` over 365 when the maturity is within a year; `null` when the amount is not positive or the maturity is on or before `on`. Exact: one `divMoney` of `minor × bp × days` by `10 000 × 365`, half-up.
  - `afterSourceTax(gross: Money): Money` (`gross × (10 000 − SOURCE_TAX_BP) / 10 000`, half-up)
  - `interestFor(db, userId, on): Promise<InterestReport>`; `InterestReport = { rows: { accountId: number; currency: string; ratePct: string; perYear: string; perYearEur: string | null; afterTaxEur: string | null; side: "earned" | "paid" }[]; earnedEur: string; earnedAfterTaxEur: string; paidEur: string }`. Earned: money balances from `cashFor` of accounts with a rate; after-tax only for `isMoneyAccount` accounts. Paid: `owed` of debt accounts with a rate. Euro values at `on`'s rate, `null` without one.

Plan's call: a fixed-term deposit past its maturity date gets no estimate ("—"), since its term and rate have ended; brokerage cash gets no after-tax figure (the source-tax rule is for bank deposits).

- [ ] **Step 1: Write the failing tests**

```ts
test("a year's interest is balance times rate", () => {
  expect(yearlyInterest(eur(10_000_00n), 250, "2026-11-10", null)).toEqual(eur(250_00n));
});
test("a fixed-term deposit earns only up to a maturity within the year", () => {
  // 73 days of 365 at 3.65 %: 10 000.00 × 0.0365 × 73/365 = 73.00
  expect(yearlyInterest(eur(10_000_00n), 365, "2026-01-01", "2026-03-15")).toEqual(eur(73_00n));
  expect(yearlyInterest(eur(10_000_00n), 365, "2026-03-15", "2026-03-15")).toBeNull();
});
test("no estimate for a zero or negative balance", () => {
  expect(yearlyInterest(eur(-5_00n), 250, "2026-11-10", null)).toBeNull();
});
test("after 30 % source tax", () => {
  expect(afterSourceTax(eur(250_00n))).toEqual(eur(175_00n));
  expect(afterSourceTax(eur(1n))).toEqual(eur(1n)); // 0.7 rounds half-up to 1
});
// server/interest.test.ts
test("earned on money accounts, paid on debts, each total in euros", async () => {
  // savings 10 000.00 at 2.50 %, loan owing 5 000.00 at 4.00 %, current account without a rate
  expect([report.earnedEur, report.earnedAfterTaxEur, report.paidEur]).toEqual([
    "250.00",
    "175.00",
    "200.00",
  ]);
  expect(report.rows).toHaveLength(2);
});
```

- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement. Cash: Money and Owed rows gain "Rate" and "Interest / year" columns (with the after-tax figure in a second line for money); under both groups: "Interest per year, estimate at today's rate: earned €250.00 (€175.00 after 30 % source tax), paid €200.00. Rates change; this is not what the bank will pay."
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5: Browser test** in `e2e/cash.spec.ts`, `a rate gives an interest-per-year estimate`: bank "Savings" rate `2,5`, manual OPENING_BALANCE `10000.00` on `2025-01-01`; Cash shows `€250.00` and `€175.00 after 30 % source tax`.
- [ ] **Step 6:** Run `pnpm test && pnpm e2e`. Expected: all pass.
- [ ] **Step 7:** Commit: `feat(cash): interest per year at today's rate, before and after source tax`.

### Task 13: "Deposit interest received" on the Tax page

**Files:**

- Create: `src/server/tax-interest.ts`
- Modify: `src/server/tax.ts` (`TaxYearView` gains `depositInterest`; `taxYearFor` fills it; `taxYearsFor` also counts years with `INTEREST` on a money account), `src/web/routes/tax.tsx` (a Section)
- Test: `src/server/tax-interest.test.ts`, `src/server/tax.test.ts`, `e2e/tax.spec.ts`

**Interfaces:**

- Produces:
  - `depositInterestFor(txns: readonly Txn[], accounts: readonly { id: number; name: string; kind: string; accountType: string | null }[], year: number): { rows: { accountName: string; amountEur: Money }[]; totalEur: Money }` (positive `INTEREST` rows of `isMoneyAccount` accounts dated in `year`, converted with each row's own `fxRateEur`; closed accounts included)
  - `TaxYearView.depositInterest: { rows: { accountName: string; amountEur: string }[]; totalEur: string }`

Plan's call: the amounts are as the bank credited them (the importer reads the credited `TALLETUSKORKO` row), so the page calls them "received, after the tax the bank withheld" and computes no gross figure.

- [ ] **Step 1: Write the failing tests:** `depositInterestFor` sums `12.34` and `5.00` on a savings account in 2025 to `17.34`, ignores a 2024 row, an `INTEREST` row on a brokerage account and one on a credit card; `taxYearsFor` includes `2025` for a user whose only 2025 row is bank interest; `taxYearFor(...).depositInterest.totalEur` is `"17.34"`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement. Tax page section "Deposit interest received": a row per account and the total, then: "Interest from a Finnish bank is taxed at source: the bank has already withheld the tax and the interest is not declared. Shown for checking, as an estimate from your imported rows."
- [ ] **Step 4:** Run `pnpm test`. Expected: PASS.
- [ ] **Step 5: Browser test** in `e2e/tax.spec.ts`, `bank interest shows as deposit interest received`: import the OP CSV (`importOpCsv`, its `TALLETUSKORKO` row of `12,34` on `2025-12-31`) into a bank account; Tax year 2025 shows "Deposit interest received" with `€12.34`.
- [ ] **Step 6:** Run `pnpm e2e`. Expected: all pass.
- [ ] **Step 7:** Commit: `feat(tax): deposit interest received per tax year`.

---

## Phase 5: Forecast lines and the assistant

### Task 14: "Cash", "Owed" and "Net" in the forecast

**Files:**

- Create: `src/core/balance-forecast.ts`
- Modify: `src/server/forecast.ts` (`ForecastReport` gains `lines`), `src/web/charts/ForecastChart.tsx` (optional `lines` prop: three more `lineY` marks and legend items), `src/web/routes/ForecastCard.tsx` (the note, the end-of-horizon sentence)
- Test: `src/core/balance-forecast.test.ts`, `src/server/forecast.test.ts`, `e2e/forecast.spec.ts`

**Interfaces:**

- Produces:
  - `type BalanceStart = { readonly side: "cash" | "owed"; readonly valueEur: number; readonly yearlyRate: number; readonly untilMonth: number | null }`
  - `type ForecastLine = { readonly index: number; readonly month: string; readonly cashEur: number; readonly owedEur: number; readonly netEur: number }`
  - `balanceLines(investments: readonly ForecastPoint[], starts: readonly BalanceStart[], scenario: Pick<ForecastScenario, "inflation" | "real">): ForecastLine[]`: per month `value × (1 + rate/12)^min(month, untilMonth)`, deflated like the engine's `deflatorAt` when `real`; `netEur = total.expected + cashEur − owedEur`; rounded to cents.
  - `ForecastReport.lines: readonly ForecastLine[]` (same length as `result.points`). Starts come from `cashFor` rows (money) and `owedFor` rows (owed) at `on`, with each account's rate (0 without one) and, for a fixed-term deposit, `untilMonth` = whole months to its maturity.

Plan's call: rates compound monthly at rate/12 (how Finnish banks quote deposit and loan rates); a fixed-term deposit stops growing at maturity; with no holdings the page keeps today's empty state (the engine is not changed); the chat's `run_forecast` is unchanged.

- [ ] **Step 1: Write the failing tests**

```ts
test("an account without a rate stays flat; one with a rate grows monthly", () => {
  const lines = balanceLines(
    flatInvestments(12, 1000),
    [
      { side: "cash", valueEur: 1200, yearlyRate: 0.12, untilMonth: null },
      { side: "owed", valueEur: 500, yearlyRate: 0, untilMonth: null },
    ],
    { real: false, inflation: 0.02 },
  );
  expect(lines[1]).toMatchObject({ cashEur: 1212, owedEur: 500, netEur: 1712 });
  expect(lines[12]?.cashEur).toBe(1352.19); // 1200 × 1.01^12
});
test("a fixed-term deposit stops growing at maturity", () => {
  // untilMonth 2: months 2 and 3 equal
});
test("real lines are in today's euros at the scenario's inflation", () => {
  // owed 1000 at 0 %, real, 2 %: month 12 = 980.39
});
// server/forecast.test.ts
test("the report carries cash, owed and net lines beside the holdings", async () => {
  expect(report.lines).toHaveLength(report.result.points.length);
  expect(report.lines[0]).toMatchObject({ cashEur: 500, owedEur: 300 });
});
```

- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement. Chart legend: "Expected (investments)", "Cash", "Owed", "Net". The note gains: "Cash and owed grow at each account's own rate; payments, draws and new deposits are not modelled, and an account without a rate stays flat." The end sentence gains "net €X".
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Update `e2e/forecast.spec.ts` where the chart title, legend or end sentence changed; add `the forecast shows cash and owed beside investments` (a bank account with an opening balance and a loan with a stated balance; the legend shows `Cash`, `Owed`, `Net`). Run `pnpm e2e`. Expected: all pass.
- [ ] **Step 6:** Commit: `feat(forecast): cash, owed and net lines at each account's rate`.

### Task 15: The assistant sees what is owed and net worth

**Files:**

- Modify: `src/server/chat/tools.ts` (`get_cash`), `src/server/chat/tools-money.ts` (`get_net_worth_series`), `src/server/chat/tools-records.ts` (`get_accounts`), `src/server/chat/runner.ts` (rule 1)
- Test: `src/server/chat/tools.test.ts`, `src/server/chat/tools-records.test.ts`, `src/server/chat/runner.test.ts`

**Interfaces:**

- Consumes: `owedFor`, `owedSeriesFor`, `interestFor`.
- Produces:
  - `get_cash` result gains `owed: { accountId, account (masked), type, currency, owed, owedEur, inCredit, source }[]`, `owedEur`, `inCreditEur`, and `interestPerYear: { earnedEur, earnedAfterTaxEur, paidEur, note: "estimate at today's rate" }`; its description says it lists money and what each loan or card owes.
  - `get_net_worth_series` points gain `owedEur` and `netEur` (the Dashboard's figure); its description says net worth is owned minus owed and names the counted-from dates in a `debtsCountedFrom` field.
  - `get_accounts` rows gain `owed` (`null` for money accounts) and its description names rate, maturity date and what is owed.
  - Rule 1 loses the sentence about debts not being visible and gains: "Net worth is what is owned minus what loans and credit cards owe: take it from get_net_worth_series, and what each debt owes from get_cash. Before a debt's counted-from date the app counts it as zero; say so when a figure reaches back that far."

- [ ] **Step 1: Write the failing tests:** `tools.test.ts` `get_cash lists what a loan owes and the interest estimate` (loan 5 000.00 at 4.00 %: `owedEur "5000.00"`, `interestPerYear.paidEur "200.00"`); `get_net_worth_series gives net worth after debts` (the Task 9 card-and-payment ledger: last point `netEur "380.00"`, `owedEur "0.00"`); `tools-records.test.ts` `get_accounts gives a debt account's amount owed` (`"120.00"`); `runner.test.ts` `the prompt no longer says debts are invisible`: `not.toContain("are not visible to you")`, `toContain("get_net_worth_series")`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement. Account names go through `maskAccountNumbers` as elsewhere.
- [ ] **Step 4:** Run `pnpm test && pnpm e2e`. Expected: all pass.
- [ ] **Step 5:** Commit: `feat(chat): the assistant sees what is owed and net worth`.

## After this plan

The owner runs `pnpm db:migrate:local` after each phase with a migration (2, 3), and before phase 3's migration notes the debts on the Debts tab: they are dropped and are added again as loan or card accounts. Deferred, as the design says: payment plans and repayment matching, rate history, a loan statement import, weekly-summary facts, notice periods on savings accounts.

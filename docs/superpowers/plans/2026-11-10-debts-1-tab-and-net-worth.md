# Debts 1: Debts Tab and Net Worth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The owner can type in a debt and its balances on a new Debts tab, and the Dashboard shows net worth (owned minus owed) with a net chart next to the unchanged gross chart.

**Architecture:** Two new tables (`debts`, `debt_balances`). The amount owed on a day is the latest balance on or before it: a pure step function in `src/core/debts.ts`, no arithmetic between balances. `src/server/debts.ts` owns reads and writes; the existing views in `src/server/views/portfolio.ts` gain owed and net figures so the client does no money arithmetic.

**Tech Stack:** TanStack Start (`createServerFn`), Cloudflare D1 with Drizzle, zod, React Query, vitest, oxlint, existing `TimeSeriesChart`.

**Spec:** `docs/superpowers/specs/2026-11-10-debts-design.md`. This plan is step 1 of its "Order of building". Steps 2 to 5 (plan rows and matching, rhythm, import recipe, forecast/summary/chat) each get their own plan after this one ships; steps 2 to 4 wait for the owner's real pasted layout.

## Global Constraints

- Kinds are exactly `student_loan` and `credit_card`. EUR only.
- Owed is stored as a non-negative integer of minor units and always subtracted. Never a signed debt.
- The app does not calculate changes: owed on a day = latest balance on or before that day. Before the first balance, owed is 0 and the UI says the debt is unknown before that date.
- Returns (TWR, XIRR), allocation, rebalance and Tax are unchanged.
- Money is `Money` from `src/core/money.ts` (bigint minor units); formatted strings cross to the client; no float money arithmetic.
- Immutable data, small files and functions, no re-exports (import from the defining module), no new dependencies, comments rare and short.
- Every server function goes through `authed`; every debt read or write is filtered by `userId`; someone else's debt answers 404.
- Do not open the owner's local database or any export file. Tests create their own users and rows.
- Work on a branch `debts`. Run `pnpm test`, `pnpm typecheck` and `pnpm lint` before each commit (the pre-commit hook does not run tests). Never push.

## Review Focus

1. A second balance for the same debt and day replaces the first (no duplicate, no error).
2. A balance dated after today is refused with a clear message.
3. A day before the first balance: owed 0, and the view reports the date balances start.
4. Another user's debt id on any write or read: 404, nothing changed.
5. Deleting a debt removes its balances and net worth equals the gross value again.

---

### Task 1: Tables

**Files:**

- Modify: `src/server/db/schema.ts` (append after `monthlyPlan`)
- Create: migration via `pnpm db:generate`
- Test: `src/server/debts.test.ts` (created in Task 3; this task is verified by typecheck and the generated SQL)

**Interfaces:**

- Produces: `debts` (`id`, `userId`, `name` text, `kind` enum `student_loan | credit_card`, `interestRateBp` integer nullable, `createdAt`) and `debtBalances` (`id`, `debtId` references `debts.id` on delete cascade, `asOf` text ISO date, `owedMinor` integer, `source` enum `import | manual` default `manual`, `importId` nullable references `imports.id`, unique on (`debtId`, `asOf`), check `owed_minor >= 0`).

- [ ] **Step 1:** Add both tables to `schema.ts`, following `monthlyPlan`'s style (`userId` cascade, `check(...)` for the non-negative amount, one doc comment each).
- [ ] **Step 2:** Run `pnpm db:generate`. Expected: one new folder under `drizzle/` creating exactly two tables and nothing else.
- [ ] **Step 3:** Run `pnpm typecheck`. Expected: clean.
- [ ] **Step 4:** Commit: `feat(debts): tables for debts and their balances`.

### Task 2: Owed on a day (pure)

**Files:**

- Create: `src/core/debts.ts`
- Test: `src/core/debts.test.ts`

**Interfaces:**

- Produces:
  - `type DebtBalance = { readonly debtId: number; readonly asOf: IsoDate; readonly owed: Money }`
  - `owedOn(balances: readonly DebtBalance[], on: IsoDate): Money` (sum over debts of each debt's latest balance with `asOf <= on`; EUR zero when none)
  - `owedSeries(balances: readonly DebtBalance[], from: IsoDate, to: IsoDate): { date: IsoDate; owedEur: Money }[]` (one point per day, same days as `datesBetween` in `src/core/returns.ts`)
  - `firstBalanceDate(balances: readonly DebtBalance[]): IsoDate | null`

- [ ] **Step 1: Write the failing tests**

```ts
const eur = (minor: bigint) => ({ minor, currency: EUR });
const balances: DebtBalance[] = [
  { debtId: 1, asOf: "2026-01-10", owed: eur(1_000_00n) },
  { debtId: 1, asOf: "2026-03-01", owed: eur(900_00n) },
  { debtId: 2, asOf: "2026-02-01", owed: eur(50_00n) },
];

test("before the first balance nothing is owed", () => {
  expect(owedOn(balances, "2026-01-09").minor).toBe(0n);
});
test("the latest balance on or before the day counts, per debt", () => {
  expect(owedOn(balances, "2026-01-10").minor).toBe(1_000_00n);
  expect(owedOn(balances, "2026-02-15").minor).toBe(1_050_00n);
  expect(owedOn(balances, "2026-03-01").minor).toBe(950_00n);
});
test("input order does not matter", () => {
  expect(owedOn([...balances].reverse(), "2026-03-01").minor).toBe(950_00n);
});
test("the series is a step line with one point per day", () => {
  const series = owedSeries(balances, "2026-02-27", "2026-03-02");
  expect(series.map((p) => p.owedEur.minor)).toEqual([1_050_00n, 1_050_00n, 950_00n, 950_00n]);
  expect(series[0]?.date).toBe("2026-02-27");
});
test("no balances: zero series and no first date", () => {
  expect(owedSeries([], "2026-01-01", "2026-01-02").every((p) => p.owedEur.minor === 0n)).toBe(
    true,
  );
  expect(firstBalanceDate([])).toBeNull();
  expect(firstBalanceDate(balances)).toBe("2026-01-10");
});
```

- [ ] **Step 2:** Run `pnpm vitest run src/core/debts.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3:** Implement the three functions. `owedSeries` walks sorted balances once (like `cashSeries` in `src/core/cash.ts`), not `owedOn` per day.
- [ ] **Step 4:** Run the test. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(debts): amount owed on a day from the latest balance`.

### Task 3: Server reads and writes

**Files:**

- Create: `src/server/debts.ts`
- Modify: `src/server/action-inputs.ts` (add the three schemas)
- Test: `src/server/debts.test.ts` (sign-up helper as in `src/server/monthly-plan.test.ts`)

**Interfaces:**

- Consumes: Task 1 tables, Task 2 functions.
- Produces (all take `db: Db, userId: string` first):
  - Schemas in `action-inputs.ts`: `DebtInput = { name: string (1..80, trimmed), kind: "student_loan" | "credit_card", interestRatePct?: string }` (decimal percent `0`..`100`, stored as basis points); `DebtBalanceInput = { debtId, asOf (YYYY-MM-DD), owedEur: string }`; `DebtBalanceRemoveInput = { debtId, asOf }`.
  - `listDebts(db, userId, on: IsoDate): Promise<{ debts: DebtView[]; totalOwedEur: string }>` where `DebtView = { id, name, kind, interestRatePct: string | null, owedEur: string, asOf: string | null, balances: { asOf: string; owedEur: string; source: "import" | "manual" }[] }` (balances newest first; `owedEur`/`asOf` are the latest balance on or before `on`, `"0.00"`/`null` when none).
  - `addDebt(db, userId, input): Promise<{ id: number }>`
  - `removeDebt(db, userId, debtId): Promise<void>`
  - `setDebtBalance(db, userId, input): Promise<void>` (upsert on (`debtId`, `asOf`), source `manual`)
  - `removeDebtBalance(db, userId, input): Promise<void>`
  - `debtBalancesFor(db, userId): Promise<DebtBalance[]>` (for the views)

- [ ] **Step 1: Write the failing tests** (each with a fresh signed-up user):

```ts
test("a new debt owes nothing until a balance is set", async () => {
  const { id } = await debts.addDebt(db, userId, {
    name: "Student loan",
    kind: "student_loan",
    interestRatePct: "4.25",
  });
  const list = await debts.listDebts(db, userId, "2026-06-01");
  expect(list.totalOwedEur).toBe("0.00");
  expect(list.debts[0]).toMatchObject({ id, interestRatePct: "4.25", owedEur: "0.00", asOf: null });
});
test("the latest balance on or before the day is what is owed", async () => {
  await debts.setDebtBalance(db, userId, { debtId: id, asOf: "2026-01-10", owedEur: "1000.00" });
  await debts.setDebtBalance(db, userId, { debtId: id, asOf: "2026-03-01", owedEur: "900.00" });
  expect((await debts.listDebts(db, userId, "2026-02-01")).totalOwedEur).toBe("1000.00");
  expect((await debts.listDebts(db, userId, "2026-03-01")).debts[0]?.asOf).toBe("2026-03-01");
});
test("a second balance on the same day replaces the first", async () => {
  await debts.setDebtBalance(db, userId, { debtId: id, asOf: "2026-01-10", owedEur: "1000.00" });
  await debts.setDebtBalance(db, userId, { debtId: id, asOf: "2026-01-10", owedEur: "750.00" });
  const view = (await debts.listDebts(db, userId, "2026-01-10")).debts[0];
  expect(view?.balances).toHaveLength(1);
  expect(view?.owedEur).toBe("750.00");
});
test("a balance dated after today is refused", async () => {
  await expect(
    debts.setDebtBalance(db, userId, { debtId: id, asOf: "2999-01-01", owedEur: "1.00" }),
  ).rejects.toMatchObject({ status: 400 });
});
test("a negative or unreadable amount is refused by the schema", () => {
  expect(
    DebtBalanceInput.safeParse({ debtId: 1, asOf: "2026-01-01", owedEur: "-5.00" }).success,
  ).toBe(false);
  expect(
    DebtBalanceInput.safeParse({ debtId: 1, asOf: "2026-01-01", owedEur: "abc" }).success,
  ).toBe(false);
  expect(DebtInput.safeParse({ name: "x", kind: "mortgage" }).success).toBe(false);
});
test("another user's debt answers 404 and is not changed", async () => {
  const other = await signUp();
  await expect(
    debts.setDebtBalance(db, other, { debtId: id, asOf: "2026-01-10", owedEur: "1.00" }),
  ).rejects.toMatchObject({ status: 404 });
  await expect(debts.removeDebt(db, other, id)).rejects.toMatchObject({ status: 404 });
  expect((await debts.listDebts(db, other, "2026-06-01")).debts).toEqual([]);
});
test("removing a debt removes its balances", async () => {
  await debts.removeDebt(db, userId, id);
  expect(await debts.debtBalancesFor(db, userId)).toEqual([]);
});
```

- [ ] **Step 2:** Run `pnpm vitest run src/server/debts.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3:** Implement. Errors are `HttpError` from `src/server/errors.ts` (400 "A balance cannot be dated in the future", 404 "Debt not found"). "Today" is the Helsinki day from `src/server/summary/helsinki.ts`. Amounts parse with `parseMoney(text, EUR)`.
- [ ] **Step 4:** Run the test. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(debts): store debts and balances per owner`.

### Task 4: Owed and net worth in the views

**Files:**

- Modify: `src/server/views/portfolio.ts` (`valueSeriesView`, `returnsView`)
- Test: the existing test file for these views (find with `grep -rl "valueSeriesView\|returnsView" src --include="*.test.ts"`); add cases there.

**Interfaces:**

- Consumes: `debtBalancesFor`, `owedOn`, `owedSeries`, `firstBalanceDate`.
- Produces:
  - Each `valueSeriesView` point gains `owedEur: string` and `netEur: string` (`valueEur + cashEur - owedEur`). Existing fields unchanged.
  - `returnsView` result gains `owedEur: string`, `netWorthEur: string` (`valueWithCashEur - owedEur`) and `debtsKnownFrom: string | null`. `twr`, `mwr` and every existing field unchanged.

- [ ] **Step 1: Write the failing tests:** a user with one holding or cash row and a debt balance of `300.00` dated inside the range: points before the balance have `owedEur "0.00"` and `netEur` equal to value plus cash; points from that day have `owedEur "300.00"` and `netEur` lower by exactly 300.00; `returnsView` gives `netWorthEur` = `valueWithCashEur` minus 300.00, `debtsKnownFrom` = the balance date, and the same `twr`/`mwr` as before the debt was added. A user with no debts: `owedEur "0.00"`, `netWorthEur === valueWithCashEur`, `debtsKnownFrom null`. Net worth may be negative: a debt larger than the assets gives a `netWorthEur` starting with `-`.
- [ ] **Step 2:** Run them. Expected: FAIL on the missing fields.
- [ ] **Step 3:** Implement with `subMoney`/`addMoney`; no change to `loadPortfolio`.
- [ ] **Step 4:** Run `pnpm test`. Expected: all pass, including every existing view test untouched.
- [ ] **Step 5:** Commit: `feat(debts): owed and net worth in the value series and totals`.

### Task 5: Debts tab

**Files:**

- Create: `src/web/server/debts.ts`, `src/web/app/_authenticated/debts.tsx`, `src/web/routes/debts.tsx`, `src/web/routes/debts-view.ts`
- Modify: `src/web/routes/session-gate.tsx` (nav link "Debts" after "Cash"), `src/server/chat/page-context.ts` (`"debts"` in `ASSISTANT_PAGES`), `src/server/chat/page-line.ts` (`debts: "Debts"`), `src/web/routes/starters.ts` (`debts: ["How much do I owe in total?", "What is my net worth?"]`)
- Test: `src/web/routes/debts-view.test.ts`, `src/web/app/routes.test.ts` (add the route as the file already does for the others)

**Interfaces:**

- Consumes: Task 3 functions and schemas.
- Produces: server functions `getDebts` (input `{ on?: IsoDate }`), `createDebt`, `deleteDebt` (input `{ debtId }`), `saveDebtBalance`, `deleteDebtBalance`: `createServerFn` with `authed` and the Task 3 schema as validator, POST for writes, in the style of `src/web/server/rebalance.ts`. Pure helpers in `debts-view.ts`: `KIND_LABELS = { student_loan: "Student loan", credit_card: "Credit card" }` and `stepPoints(balances: { asOf: string; owedEur: string }[], today: string): { date: string; value: number }[]` (oldest first, plus a final point at `today` carrying the last value, so the chart reaches today).

- [ ] **Step 1:** Write failing tests for `stepPoints`: empty in gives empty out; two balances give three points ending at `today` with the last value; a balance dated `today` adds no duplicate point.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement `debts-view.ts` and the server functions; run the tests. Expected: PASS.
- [ ] **Step 4:** Build the page (follow `src/web/routes/cash.tsx` for queries, forms, error display and React Query invalidation; invalidate the Dashboard's queries too after any write):
  - Heading "Debts"; a `Stat`-like line "Owed in total".
  - Per debt, a card: name, kind label, interest rate if set, "Owed" with "as of <date>" (or "No balance yet"), a table of balances newest first with a remove button each, and a small form "Add a balance" (`<input type="date">` max today, amount).
  - A `TimeSeriesChart` labelled "Owed" per debt once it has a balance, fed by `stepPoints`. If the chart requires `invested` or `cash` on a point, make those two optional in `src/web/charts/TimeSeriesChart.tsx` rather than passing zeros.
  - "Add a debt" form: name, kind select, optional interest rate percent.
  - Removing a debt asks first with the existing `Modal`, in the warning style, saying its balances go too.
  - Empty state: "No debts yet. Add your student loan or credit card to see your net worth."
- [ ] **Step 5:** Run `pnpm test && pnpm typecheck && pnpm lint`. Expected: clean (the route tree regenerates on `pnpm dev` or build; commit the regenerated `src/web/routeTree.gen.ts`).
- [ ] **Step 6:** Commit: `feat(debts): a Debts tab to add debts and balances by hand`.

### Task 6: Net worth on the Dashboard

**Files:**

- Modify: `src/web/routes/dashboard.tsx`
- Test: none new (no DOM tests in this repo; the figures are covered by Task 4). Verify by typecheck and by hand in `pnpm dev`.

**Interfaces:**

- Consumes: `returns.data.owedEur`, `netWorthEur`, `debtsKnownFrom`; series points' `netEur`.

- [ ] **Step 1:** When `returns.data.owedEur !== "0.00"`: add a first `Stat` "Net worth" = `netWorthEur`, note `owned <valueWithCashEur> − owed <owedEur>`, tone `loss` when negative. "Portfolio value" stays as it is. With no debt, the Dashboard looks exactly as today.
- [ ] **Step 2:** When any point has `owedEur !== "0.00"`: add a card "Net worth over time" above the existing chart: `TimeSeriesChart` with label "Net worth" and `value: Number(p.netEur)`. Under it, when `debtsKnownFrom` is set: "Debts are counted from <date>, the first balance on record." Rename the existing card's heading to "Value over time (before debts)"; its data is unchanged.
- [ ] **Step 3:** Run `pnpm test && pnpm typecheck && pnpm lint`. Expected: clean.
- [ ] **Step 4:** Add to `README.md`, where pages are listed: one line for the Debts tab and net worth (typed by hand for now; import comes later).
- [ ] **Step 5:** Commit: `feat(debts): net worth on the Dashboard, gross chart kept`.

## After this plan

The owner runs `pnpm db:migrate:local`. Not seen in a browser by the builder unless `pnpm dev` was run: say so in the hand-over. Next plan: step 2 of the spec (plan rows, plan matching, the spending split), once the owner can paste a real loan view.

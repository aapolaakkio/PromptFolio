# Finnish Tax Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-tax-year verification report — realised gains, dividends and OST withdrawals computed independently from the ledger, so the pre-filled Finnish tax return can be checked against a second visible derivation.

**Architecture:** Pure rules in `src/core/tax/` (no I/O), a translation layer in `src/server/tax.ts` producing decimal strings, one read-only route, one React tab, one chat tool. Figures are derived on demand, never stored — the choice §10e E2 already made for cash.

**Tech Stack:** Bun 1.4, TypeScript, Drizzle, React + TanStack Router/Query, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-08-29-tax-module-design.md`

## Global Constraints

- Money is integers: `Money{minor: bigint}`, quantities scaled 10⁶, FX 10⁸. Decimal strings on the wire, never JSON floats.
- `src/core` never sees a database row and performs no I/O.
- No test may touch the network; a preload replaces `fetch` with one that throws.
- `bun run check` must pass: oxlint (with vendored `anti-slop` rules), oxfmt, `tsc --noEmit`, tests at an 80 % per-file coverage floor.
- Every tax constant carries its vero.fi citation as a comment (spec §3).
- The 30 %/34 % bracket rates appear **nowhere**, not even as unused constants (spec §2).
- Finnish user-facing copy, matching existing wording ("tuntematon", "ei hintaa", "vanha").
- Never write to `./data/promptfolio.db` during verification; use a scratch database.

---

### Task 1: FIFO per account

`buildLots` keys lots by `instrumentId` alone; `accountId` appears nowhere in the file. vero.fi requires FIFO *within one account*. No instrument is currently held in two brokerage accounts, so today's answer is accidentally right — this makes it right by construction. The same change adds the per-lot fee that Task 3 needs for gross proceeds.

**Files:**
- Modify: `src/core/costbasis.ts`
- Test: `src/core/costbasis.test.ts`

**Interfaces:**
- Produces: `Lot` and `Disposal` both gain `readonly accountId: number`; `Disposal` gains `readonly feeEur: Money` (that lot's pro-rata share of the sale's fee, in EUR).
- `costBasisAt` and `costBasisPerInstrument` keep their current signatures and keep aggregating per instrument across accounts.

- [ ] **Step 1: Write the failing tests**

```typescript
test("FIFO is per account: disposing from one account does not consume another's lots", () => {
  // Same instrument, two accounts, cheap lot in account 1 and dear lot in account 2.
  // Selling from account 2 must use account 2's dear lot -- pooling the lots would
  // wrongly take the cheap one first and overstate the gain.
  const { disposals } = buildLots([
    txn("BUY", "2025-01-10", { qty: "10", amount: "-100,00", accountId: 1 }),
    txn("BUY", "2025-02-10", { qty: "10", amount: "-500,00", accountId: 2 }),
    txn("SELL", "2025-06-01", { qty: "10", amount: "600,00", accountId: 2 }),
  ]);
  expect(disposals).toHaveLength(1);
  expect(formatMoney(disposals[0]!.costEur)).toBe("500.00");
  expect(disposals[0]!.accountId).toBe(2);
});

test("a disposal carries its share of the sale fee, for the deemed-cost base", () => {
  const { disposals } = buildLots([
    txn("BUY", "2025-01-10", { qty: "10", amount: "-100,00", accountId: 1 }),
    txn("SELL", "2025-06-01", { qty: "10", amount: "590,00", fee: "10,00", accountId: 1 }),
  ]);
  // `amount` is already net of the fee (Txn.amount's doc), so gross is amount + fee.
  expect(formatMoney(disposals[0]!.proceedsEur)).toBe("590.00");
  expect(formatMoney(disposals[0]!.feeEur)).toBe("10.00");
});
```

- [ ] **Step 2: Run and watch them fail** — `bun test src/core/costbasis.test.ts`. Expected: `accountId`/`feeEur` do not exist on the type.

- [ ] **Step 3: Implement**

Key the open-lot map by account and instrument, and pro-rate the fee exactly as proceeds are already pro-rated (last lot absorbs the remainder, so the parts sum to the whole):

```typescript
const lotKey = (accountId: number, instrumentId: number): string => `${accountId}:${instrumentId}`;
```

`openByInstrument` becomes `openByAccountInstrument`, keyed by `lotKey(t.accountId, t.instrumentId)`. `carriedBasis` stays keyed by trade date: a share swap moves between *instruments*, not accounts, so its queue is unaffected. Each pushed `Lot` gains `accountId: t.accountId`; each pushed `Disposal` gains `accountId: t.accountId` and `feeEur`, computed with the same `isFinalShare` remainder pattern as `shareOfProceeds`.

`costBasisAt` still totals by `lot.instrumentId`, so `holdingsFor` is unchanged.

- [ ] **Step 4: Run the full suite** — `bun run check`. The existing costbasis, valuation, holdings and import tests must all still pass; any change in a holdings figure means the aggregation regressed.

- [ ] **Step 5: Commit** — `fix: FIFO cost basis is per account, as the tax rule requires`

---

### Task 2: The rules as constants

**Files:**
- Create: `src/core/tax/rates.ts`, `src/core/tax/rates.test.ts`

**Interfaces:**
- Produces: `DEEMED_COST_SHORT_PERCENT = 20n`, `DEEMED_COST_LONG_PERCENT = 40n`, `DEEMED_COST_LONG_YEARS = 10`, `SMALL_SALE_LIMIT_EUR: Money` (1 000,00 €), `DIVIDEND_TAXABLE_PERCENT = 85n`, `LOSS_CARRY_YEARS = 5`, `OST_DEPOSIT_CAP_EUR: Money` (100 000,00 €), and `percentOf(m: Money, percent: bigint): Money`.

- [ ] **Step 1: Write the failing test**

```typescript
test("percentOf rounds half-up to the cent, in integers", () => {
  // 20 % of 12,34 € = 2,468 -> 2,47. Never via a float.
  expect(formatMoney(percentOf(parseMoney("12,34", EUR), 20n))).toBe("2.47");
  expect(formatMoney(percentOf(parseMoney("-12,34", EUR), 20n))).toBe("-2.47");
});

test("the limits are the figures vero.fi states", () => {
  expect(formatMoney(SMALL_SALE_LIMIT_EUR)).toBe("1000.00");
  expect(formatMoney(OST_DEPOSIT_CAP_EUR)).toBe("100000.00");
});
```

- [ ] **Step 2: Run and watch it fail** — module does not exist.

- [ ] **Step 3: Implement.** `percentOf` reuses `divMoney`, which already rounds half-up on magnitude:

```typescript
export const percentOf = (m: Money, percent: bigint): Money =>
  divMoney(money(m.minor * percent, m.currency), 100n, "half-up");
```

Each constant carries a comment naming the vero.fi page it came from and the date it was verified (2026-08-29).

- [ ] **Step 4: Run** — `bun test src/core/tax/rates.test.ts`.

- [ ] **Step 5: Commit** — `feat: Finnish tax constants, each with its vero.fi citation`

---

### Task 3: Taxable disposals, both methods

**Files:**
- Create: `src/core/tax/disposals.ts`, `src/core/tax/disposals.test.ts`

**Interfaces:**
- Consumes: `Disposal` (with `accountId`, `feeEur`) from Task 1; `percentOf` and the deemed-cost constants from Task 2.
- Produces:

```typescript
export type TaxMethod = "actual" | "deemed";

export type TaxableDisposal = {
  readonly instrumentId: number;
  readonly accountId: number;
  readonly acquiredOn: IsoDate;
  readonly soldOn: IsoDate;
  readonly quantity: Quantity;
  readonly netProceedsEur: Money;    // fee already deducted -- the actual-cost base
  readonly grossProceedsEur: Money;  // net + fee -- the deemed-cost base
  readonly actualCostEur: Money;
  readonly deemedCostEur: Money;
  readonly deemedPercent: bigint;    // 20n or 40n
  readonly actualGainEur: Money;
  readonly deemedGainEur: Money;
  readonly method: TaxMethod;        // the more favourable of the two
  readonly gainEur: Money;           // the gain under `method`
};

export const taxableDisposals = (args: {
  readonly disposals: readonly Disposal[];
  readonly ostAccountIds: ReadonlySet<number>;
  readonly transferOutIds?: never;
}) => TaxableDisposal[];
```

- [ ] **Step 1: Write the failing tests**

```typescript
test("takes the deemed cost when it beats the actual cost", () => {
  // Bought for 100 €, sold for 1 000 € after 11 years: actual gain 900 €,
  // deemed cost 40 % of 1 000 = 400 €, deemed gain 600 €. The taxpayer may
  // take either, so reporting only the actual one overstates the tax.
  const [row] = taxableDisposals({ disposals: [disposal({
    acquiredOn: "2014-01-10", soldOn: "2025-06-01",
    proceeds: "1000,00", fee: "0,00", cost: "100,00",
  })], ostAccountIds: new Set() });
  expect(row!.deemedPercent).toBe(40n);
  expect(formatMoney(row!.deemedGainEur)).toBe("600.00");
  expect(row!.method).toBe("deemed");
  expect(formatMoney(row!.gainEur)).toBe("600.00");
});

test("uses 20 % below ten years and 40 % from ten years", () => {
  const short = taxableDisposals({ disposals: [disposal({
    acquiredOn: "2016-06-02", soldOn: "2026-06-01", proceeds: "1000,00", fee: "0,00", cost: "100,00",
  })], ostAccountIds: new Set() })[0]!;
  expect(short.deemedPercent).toBe(20n);
  // Exactly ten years to the day is "at least ten years".
  const exact = taxableDisposals({ disposals: [disposal({
    acquiredOn: "2016-06-01", soldOn: "2026-06-01", proceeds: "1000,00", fee: "0,00", cost: "100,00",
  })], ostAccountIds: new Set() })[0]!;
  expect(exact.deemedPercent).toBe(40n);
});

test("the deemed cost is a share of the gross sale price, the actual method deducts the fee", () => {
  // Under the deemed method the selling fee is not separately deductible, so
  // the two methods do not share a base. One base for both would quietly
  // favour the wrong method.
  const row = taxableDisposals({ disposals: [disposal({
    acquiredOn: "2024-01-10", soldOn: "2025-06-01", proceeds: "990,00", fee: "10,00", cost: "100,00",
  })], ostAccountIds: new Set() })[0]!;
  expect(formatMoney(row.grossProceedsEur)).toBe("1000.00");
  expect(formatMoney(row.actualGainEur)).toBe("890.00");   // 990 - 100
  expect(formatMoney(row.deemedCostEur)).toBe("200.00");   // 20 % of 1 000
  expect(formatMoney(row.deemedGainEur)).toBe("800.00");   // 1 000 - 200
});

test("a disposal inside an OST is not a taxable event", () => {
  // Tax inside an OST falls on withdrawal. Counting the sale as well would
  // tax the same money twice.
  expect(taxableDisposals({
    disposals: [disposal({ accountId: 7, acquiredOn: "2024-01-10", soldOn: "2025-06-01",
      proceeds: "1000,00", fee: "0,00", cost: "100,00" })],
    ostAccountIds: new Set([7]),
  })).toEqual([]);
});

test("a loss never takes the deemed method", () => {
  // The deemed cost cannot create or enlarge a loss: it is an alternative
  // acquisition cost, and a taxpayer claiming it on a losing sale would be
  // claiming a bigger loss than they suffered.
  const row = taxableDisposals({ disposals: [disposal({
    acquiredOn: "2024-01-10", soldOn: "2025-06-01", proceeds: "50,00", fee: "0,00", cost: "100,00",
  })], ostAccountIds: new Set() })[0]!;
  expect(row.method).toBe("actual");
  expect(formatMoney(row.gainEur)).toBe("-50.00");
});
```

- [ ] **Step 2: Run and watch them fail.**

- [ ] **Step 3: Implement.** Filter out any disposal whose `accountId` is in `ostAccountIds`. Transfers never reach here: `buildLots` records a `TRANSFER_OUT` as a disposal for cost-basis purposes, so `taxableDisposals` is only ever handed the SELL-derived disposals — the caller (Task 6) does that filtering, and Task 6's tests prove it. Ownership duration:

```typescript
/** True when `soldOn` is on or after the `years`th anniversary of `acquiredOn`. */
const heldAtLeast = (acquiredOn: IsoDate, soldOn: IsoDate, years: number): boolean => {
  const anniversary = new Date(`${acquiredOn}T00:00:00Z`);
  anniversary.setUTCFullYear(anniversary.getUTCFullYear() + years);
  return soldOn >= anniversary.toISOString().slice(0, 10);
};
```

`method` is `"deemed"` only when `deemedGainEur < actualGainEur` **and** `actualGainEur > 0`.

- [ ] **Step 4: Run** — `bun test src/core/tax/disposals.test.ts`.

- [ ] **Step 5: Commit** — `feat: taxable disposals, computed both ways`

---

### Task 4: Dividends

**Files:**
- Create: `src/core/tax/dividends.ts`, `src/core/tax/dividends.test.ts`

**Interfaces:**
- Produces:

```typescript
export type TaxableDividend = {
  readonly accountId: number;
  readonly instrumentId: number | null;
  readonly paidOn: IsoDate;
  readonly grossEur: Money;
  readonly withheldEur: Money;
  readonly taxableEur: Money;   // 85 % of gross
};

export const taxableDividends = (args: {
  readonly txns: readonly Txn[];
  readonly ostAccountIds: ReadonlySet<number>;
  readonly from: IsoDate;
  readonly to: IsoDate;
}) => TaxableDividend[];
```

- [ ] **Step 1: Write the failing tests**

```typescript
test("85 % of the gross dividend is taxable capital income", () => {
  const [row] = taxableDividends({
    txns: [dividend({ accountId: 1, amount: "74,50", tax: "25,50", paidOn: "2025-04-07" })],
    ostAccountIds: new Set(), from: "2025-01-01", to: "2025-12-31",
  });
  // `amount` is the cash that arrived, net of the 25,5 % withheld; the gross
  // is what the company paid before withholding.
  expect(formatMoney(row!.grossEur)).toBe("100.00");
  expect(formatMoney(row!.withheldEur)).toBe("25.50");
  expect(formatMoney(row!.taxableEur)).toBe("85.00");
});

test("a dividend inside an OST is not taxed when it is paid", () => {
  expect(taxableDividends({
    txns: [dividend({ accountId: 7, amount: "74,50", tax: "25,50", paidOn: "2025-04-07" })],
    ostAccountIds: new Set([7]), from: "2025-01-01", to: "2025-12-31",
  })).toEqual([]);
});

test("stays inside the tax year", () => {
  expect(taxableDividends({
    txns: [dividend({ accountId: 1, amount: "74,50", tax: "25,50", paidOn: "2024-12-31" })],
    ostAccountIds: new Set(), from: "2025-01-01", to: "2025-12-31",
  })).toEqual([]);
});
```

- [ ] **Step 2: Run and watch them fail.**

- [ ] **Step 3: Verify the gross convention against real data before implementing.** Run, against a scratch copy of the database:

```
select amount, tax, note from transactions where type = 'DIVIDEND' limit 5
```

`grossEur = amount + tax` holds only if the importer stores the *net* cash in `amount` and the withheld tax in `tax`. If a real row shows `tax = 0` with a gross-looking `amount`, the withholding is not being captured and the plan's assumption is wrong: report that finding rather than coding around it, since a "gross" that is really net understates the taxable 85 %.

- [ ] **Step 4: Implement** — filter to `DIVIDEND`, exclude OST accounts, window by date, `taxableEur = percentOf(grossEur, DIVIDEND_TAXABLE_PERCENT)`, converting with `toEur(..., t.fxRateEur)`.

- [ ] **Step 5: Run** — `bun test src/core/tax/dividends.test.ts`.

- [ ] **Step 6: Commit** — `feat: dividends, 85 % taxable`

---

### Task 5: OST withdrawals

The account's deposits, its value, and its profit share move together, so one pass over the account's history serves the withdrawal tax *and* the deposit cap: the non-profit part of a withdrawal reduces cumulative deposits for both purposes.

**Files:**
- Create: `src/core/tax/ost.ts`, `src/core/tax/ost.test.ts`

**Interfaces:**
- Produces:

```typescript
/** The account's fair market value on a date, or the instrument that has no price. */
export type OstValuation =
  | { readonly ok: true; readonly valueEur: Money }
  | { readonly ok: false; readonly instrumentId: number };

export type OstWithdrawal = {
  readonly withdrawnOn: IsoDate;
  readonly amountEur: Money;
  readonly outcome:
    | { readonly ok: true; readonly valueEur: Money; readonly profitEur: Money; readonly taxableEur: Money }
    | { readonly ok: false; readonly instrumentId: number };
};

export type OstReport = {
  readonly withdrawals: readonly OstWithdrawal[];
  readonly depositedEur: Money;        // cumulative payments in, less the capital returned
  readonly capRemainingEur: Money;     // 100 000 € less depositedEur, floored at zero
};

export const ostReport = (args: {
  readonly txns: readonly Txn[];        // this OST account's transactions, all years
  readonly valueAt: (on: IsoDate) => OstValuation;
  readonly from: IsoDate;               // withdrawals reported for this year only
  readonly to: IsoDate;
}) => OstReport;
```

- [ ] **Step 1: Write the failing tests**

```typescript
test("vero.fi's own worked example", () => {
  // 15 000 € on the account, of which 5 000 € is profit; 1 500 € withdrawn
  // -> 500 € taxable. Checked against the authority's own arithmetic rather
  // than against our reading of it.
  const report = ostReport({
    txns: [deposit("2020-01-02", "10000,00"), withdrawal("2025-06-01", "1500,00")],
    valueAt: () => ({ ok: true, valueEur: parseMoney("15000,00", EUR) }),
    from: "2025-01-01", to: "2025-12-31",
  });
  const outcome = report.withdrawals[0]!.outcome;
  expect(outcome.ok).toBe(true);
  if (outcome.ok) {
    expect(formatMoney(outcome.profitEur)).toBe("5000.00");
    expect(formatMoney(outcome.taxableEur)).toBe("500.00");
  }
});

test("the capital part of a withdrawal reduces the deposits, for the next withdrawal and the cap", () => {
  // 1 500 € out, of which 500 € was profit: 1 000 € was capital returned, so
  // deposits fall from 10 000 to 9 000 -- vero.fi: "the part of withdrawn
  // funds that is not counted as profit reduces the total amount of cash
  // payments made to the account".
  const report = ostReport({
    txns: [deposit("2020-01-02", "10000,00"), withdrawal("2025-06-01", "1500,00")],
    valueAt: () => ({ ok: true, valueEur: parseMoney("15000,00", EUR) }),
    from: "2025-01-01", to: "2025-12-31",
  });
  expect(formatMoney(report.depositedEur)).toBe("9000.00");
  expect(formatMoney(report.capRemainingEur)).toBe("91000.00");
});

test("an account worth no more than its deposits yields no taxable profit", () => {
  const report = ostReport({
    txns: [deposit("2020-01-02", "10000,00"), withdrawal("2025-06-01", "1000,00")],
    valueAt: () => ({ ok: true, valueEur: parseMoney("8000,00", EUR) }),
    from: "2025-01-01", to: "2025-12-31",
  });
  const outcome = report.withdrawals[0]!.outcome;
  // A loss on an OST is deductible only in the year the account is closed,
  // so a withdrawal at a loss is simply not taxable income -- never a
  // negative "taxable" figure.
  if (outcome.ok) expect(formatMoney(outcome.taxableEur)).toBe("0.00");
});

test("a withdrawal whose account cannot be valued names the instrument, and never guesses", () => {
  const report = ostReport({
    txns: [deposit("2020-01-02", "10000,00"), withdrawal("2025-06-01", "1500,00")],
    valueAt: () => ({ ok: false, instrumentId: 42 }),
    from: "2025-01-01", to: "2025-12-31",
  });
  const outcome = report.withdrawals[0]!.outcome;
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) expect(outcome.instrumentId).toBe(42);
});
```

- [ ] **Step 2: Run and watch them fail.**

- [ ] **Step 3: Implement.** Walk the account's transactions in date order, carrying `deposited`. A `DEPOSIT` adds `amount`. A `WITHDRAWAL` values the account on that date; on `ok`, `profit = max(0, value - deposited)`, `taxable = percentOfMoney(withdrawn × profit ÷ value)` computed as an exact integer ratio (`divMoney(money(profit.minor * withdrawn.minor / ...))` — use `proRata`-style integer arithmetic, never a float), then `deposited -= (withdrawn - taxable)`. On `!ok`, record the blocker and leave `deposited` unchanged, because the split is unknown. Only withdrawals within `[from, to]` are returned; earlier ones still advance the state.

- [ ] **Step 4: Run** — `bun test src/core/tax/ost.test.ts`.

- [ ] **Step 5: Commit** — `feat: OST withdrawal apportionment and deposit cap`

---

### Task 6: The tax year

**Files:**
- Create: `src/core/tax/year.ts`, `src/core/tax/year.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:

```typescript
export type TaxYear = {
  readonly year: number;
  readonly disposals: readonly TaxableDisposal[];
  readonly totalSalePriceEur: Money;      // gross, for the exemption test
  readonly exempt: boolean;               // total sale prices <= 1 000 €
  readonly gainsEur: Money;
  readonly lossesEur: Money;
  readonly netEur: Money;
  readonly lossCarriedInEur: Money;
  readonly lossCarriedOutEur: readonly { readonly fromYear: number; readonly amountEur: Money }[];
  readonly dividends: readonly TaxableDividend[];
  readonly dividendTaxableEur: Money;
  readonly ost: OstReport | null;
};

export const taxYear = (args: {
  readonly txns: readonly Txn[];
  readonly disposals: readonly Disposal[];
  readonly ostAccountIds: ReadonlySet<number>;
  readonly ostValueAt: (accountId: number, on: IsoDate) => OstValuation;
  readonly year: number;
}) => TaxYear;
```

- [ ] **Step 1: Write the failing tests**

```typescript
test("a year under the 1 000 € threshold is exempt, and its losses do not carry", () => {
  // The exemption cuts both ways: reporting it without dropping the losses
  // would overstate the carry-forward.
  const year = taxYear({ ...base, year: 2025, disposals: [
    disposalIn(2025, { proceeds: "400,00", cost: "900,00" }),
  ]});
  expect(year.exempt).toBe(true);
  expect(formatMoney(year.netEur)).toBe("0.00");
  expect(year.lossCarriedOutEur).toEqual([]);
});

test("exactly 1 000 € of sales is still exempt", () => {
  const year = taxYear({ ...base, year: 2025, disposals: [
    disposalIn(2025, { proceeds: "1000,00", cost: "100,00" }),
  ]});
  expect(year.exempt).toBe(true);
});

test("a loss carries into the fifth year and is gone in the sixth", () => {
  const withLoss = [disposalIn(2020, { proceeds: "2000,00", cost: "3000,00" })];
  const fifth = taxYear({ ...base, year: 2025, disposals: [...withLoss,
    disposalIn(2025, { proceeds: "5000,00", cost: "4000,00" })] });
  expect(formatMoney(fifth.lossCarriedInEur)).toBe("1000.00");
  const sixth = taxYear({ ...base, year: 2026, disposals: [...withLoss,
    disposalIn(2026, { proceeds: "5000,00", cost: "4000,00" })] });
  expect(formatMoney(sixth.lossCarriedInEur)).toBe("0.00");
});

test("a transfer between the owner's own accounts is not a taxable disposal", () => {
  // buildLots records a TRANSFER_OUT as a disposal so cost basis follows the
  // shares. Moving one's own shares is not a sale, and counting it would
  // report a gain that was never realised.
  const year = taxYear({ ...base, year: 2025,
    txns: [transferOut("2025-06-01"), transferIn("2025-06-01")],
    disposals: [transferDisposal(2025, { proceeds: "5000,00", cost: "1000,00" })] });
  expect(year.disposals).toEqual([]);
});
```

- [ ] **Step 2: Run and watch them fail.**

- [ ] **Step 3: Implement.** Match each `Disposal` to the transaction that produced it by `(accountId, instrumentId, soldOn)` and keep only those whose type is `SELL` — that is what excludes transfers. Compute the exemption from the year's total *gross* sale prices. When exempt, gains and losses are both zero. Losses net against gains within the year first, then the carry-in from the previous five years, oldest first.

- [ ] **Step 4: Run** — `bun test src/core/tax/year.test.ts`.

- [ ] **Step 5: Commit** — `feat: assemble a tax year, with exemption and loss carry-forward`

---

### Task 7: Server translation

**Files:**
- Create: `src/server/tax.ts`, `src/server/tax.test.ts`

**Interfaces:**
- Consumes: `loadPortfolio` from `src/server/valuation.ts`, `taxYear` from Task 6.
- Produces: `taxYearFor(db: Db, userId: string, year: number): TaxYearView` and `taxYearsFor(db, userId): number[]`, with every money field a decimal string and every blocked OST row carrying the instrument's `name` and `isin` (core returns only an id; the user must never be shown an internal numeric id — the convention `explainUnmatchedDisposal` already follows).

- [ ] **Step 1: Write the failing test** — seed a scratch database with a BUY and a later SELL, assert the view's `gainEur` is a decimal string and that a blocked OST row names the instrument rather than its id.

- [ ] **Step 2: Run and watch it fail.**

- [ ] **Step 3: Implement.** `ostValueAt` values the OST from the same `PriceLookup` `holdingsFor` uses: positions on that date × price, plus the account's cash. A position with no price returns `{ ok: false, instrumentId }`.

- [ ] **Step 4: Run** — `bun test src/server/tax.test.ts`.

- [ ] **Step 5: Commit** — `feat: tax year as a view, with names instead of ids`

---

### Task 8: The route

**Files:**
- Create: `src/server/api/tax.ts`, `src/server/api/tax.test.ts`
- Modify: `src/server/index.ts` (mount `taxRoutes`)

**Interfaces:**
- Produces: `GET /api/tax/years` → `number[]`; `GET /api/tax?year=YYYY` → `TaxYearView`.

- [ ] **Step 1: Write the failing tests** — a signed-in caller gets 200 and the year's figures; an anonymous caller gets 401; a non-numeric `year` gets 400; one user never sees another's disposals (the scoping test every route in this codebase has).

- [ ] **Step 2: Run and watch them fail.**

- [ ] **Step 3: Implement** using the existing route/auth/validation helpers in `src/server/api/`, validating `year` with zod at the boundary.

- [ ] **Step 4: Run** — `bun test src/server/api/tax.test.ts`.

- [ ] **Step 5: Commit** — `feat: GET /api/tax`

---

### Task 9: The Verot tab

**Files:**
- Create: `src/web/routes/tax.tsx`
- Modify: the router and nav (alongside the existing `Kulutus` entry)

- [ ] **Step 1: Build the screen.** A year selector fed by `/api/tax/years`, then the six sections of spec §4. Every figure shows its workings: a disposal row shows proceeds, cost and gain, with the method used marked and the rejected method's figure beside it, so the choice is visible rather than asserted. A blocked OST row reads like the holdings screen's own gaps — a short badge with the reason on hover — naming the instrument and date, and saying that recording a price for that date makes the row compute.

- [ ] **Step 2: Verify by eye** — `bun run dev`, open the tab, check a year with disposals and a year without. A year with no taxable event must say so, not render empty tables.

- [ ] **Step 3: Commit** — `feat: Verot tab`

---

### Task 10: The chat tool

**Files:**
- Modify: `src/server/chat/tools.ts`, `src/server/chat/tools.test.ts`

- [ ] **Step 1: Write the failing test** — `get_tax_year` returns the same figures `taxYearFor` returns, and is read-only.

- [ ] **Step 2: Implement** it as a thin call through `src/server/tax.ts`, like every other tool, so chat and screen cannot disagree.

- [ ] **Step 3: Run** — `bun test src/server/chat/`.

- [ ] **Step 4: Commit** — `feat: get_tax_year chat tool`

---

### Task 11: Documentation

**Files:**
- Modify: `README.md`, `docs/HANDOVER.md`, `docs/superpowers/specs/2026-08-27-portfolio-manager-design.md`

- [ ] **Step 1: README** — a Verot row in the screens table; move "no tax reporting yet" out of Limits and replace it with what the module does *not* do (no tax owed, no foreign tax credit, no filing export).
- [ ] **Step 2: HANDOVER** — add the module to "What exists", and add "FIFO is per account" to the decisions list.
- [ ] **Step 3: Phase 1 spec** — a short §10g amendment recording the two corrections found while designing this: the OST cap is 100 000 € (C7 says 50 000 €), and §11's deferred rules are now answered in the phase 4 spec.
- [ ] **Step 4: Commit** — `docs: phase 4 shipped`

---

## Self-review

**Spec coverage.** §3 rules → Task 2. §4's six report sections → Tasks 3–6 (1–3 in Task 6, 4 in Task 4, 5–6 in Task 5), rendered in Task 9. §5 module boundaries → Tasks 2–8, one file each. §6.1 per-account FIFO → Task 1. §6.2 exclusions → Task 3 (OST), Task 4 (OST dividends), Task 6 (transfers). §6.3 gross vs net → Tasks 1 and 3. §6.4 exemption both ways → Task 6. §6.5 duration → Task 3. §6.6 integer arithmetic → Task 2. §7 blockers → Tasks 5, 7, 9. §8 testing → the tests in each task. §9 not-built → nothing to implement.

**Type consistency.** `TaxableDisposal.gainEur` is the figure Task 6 nets and Task 9 renders. `OstValuation` is produced by Task 7's `ostValueAt` and consumed by Task 5's `valueAt`. `Disposal.feeEur` and `Disposal.accountId` come from Task 1 and are read in Tasks 3 and 6.

**Known risk, resolved in-task.** Task 4 Step 3 verifies against real rows that a dividend's gross is `amount + tax` before the 85 % is applied to it. If the importer does not capture withholding, the assumption is wrong and the finding is reported rather than coded around.

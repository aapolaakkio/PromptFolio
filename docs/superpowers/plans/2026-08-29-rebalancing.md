# Rebalancing, Drift and Fees Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A target allocation the owner sets, the drift against it, a suggestion for where to direct new money, a full-rebalance view that names the gain each sale would realise, and a fee report that excludes withheld tax.

**Architecture:** Pure rules in `src/core/rebalance/` (no I/O) over the existing `allocateBy`, a translation layer in `src/server/rebalance.ts` producing decimal strings, read routes plus one write route for targets, and a **Tasapaino** tab. Targets are the only new stored state; everything else is derived on demand, as cash and tax already are.

**Tech Stack:** Bun 1.4, TypeScript, Drizzle, React + TanStack Router/Query, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-08-29-rebalancing-design.md`

## Global Constraints

- Money is integers: `Money{minor: bigint}`, quantities scaled 10⁶, FX 10⁸. Decimal strings on the wire, never JSON floats.
- Target weights are integers in **basis points** (6 000 = 60 %), never floats — a set sums to exactly 100 % or it is refused.
- `src/core` never sees a database row and performs no I/O.
- No test may touch the network; a preload replaces `fetch` with one that throws.
- `bun run check` must pass: oxlint (with vendored `anti-slop` rules), oxfmt, `tsc --noEmit`, tests at an 80 % per-file coverage floor.
- Finnish user-facing copy, matching existing wording (`tuntematon`, `ei hintaa`, `vanha`).
- No figure for tax owed anywhere — a suggested sale reports the **gain** it realises, never the tax (spec §6.3).
- Never write to `./data/promptfolio.db` during verification; use a scratch database.

---

### Task 1: The targets table

**Files:**
- Modify: `src/server/db/schema.ts`
- Create: a migration via `bun run db:generate`
- Test: `src/server/db/schema.test.ts`

**Interfaces:**
- Produces: `allocationTargets` table with `id`, `userId`, `dimension`, `key`, `weightBp`, `createdAt`.

- [ ] **Step 1: Add the table**

```typescript
/**
 * A target allocation: what share of the portfolio the owner wants one slice
 * of one dimension to hold.
 *
 * The weight is basis points as an integer (6 000 = 60 %), not a percentage as
 * a float: §4.1's rule that nothing quantitative is a float applies here too,
 * and it makes "this set sums to exactly 100 %" a check on integers rather than
 * an epsilon comparison that is wrong twice a year.
 *
 * A set is bound to one `dimension`. Targets across two dimensions can
 * contradict each other -- 60 % equities and 50 % at one broker are each
 * reasonable and jointly unsatisfiable -- and no useful drift figure comes out
 * of a contradiction.
 */
export const allocationTargets = sqliteTable(
  "allocation_targets",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    dimension: text("dimension", { enum: ["kind", "currency", "account", "instrument"] }).notNull(),
    /** The slice this targets: `core/allocation.ts`'s `Slice.key` for that dimension. */
    key: text("key").notNull(),
    weightBp: integer("weight_bp").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(sql`(unixepoch() * 1000)`),
  },
  (t) => [unique().on(t.userId, t.dimension, t.key)],
);
```

- [ ] **Step 2: Generate the migration** — `bun run db:generate`, then read the generated SQL and confirm it creates the table and the unique index and touches nothing else.

- [ ] **Step 3: Write the test**

```typescript
test("a user cannot hold two targets for the same slice", () => {
  const { db } = testDb();
  db.insert(user).values({ id: "u1", name: "T", email: "t@example.com", emailVerified: false }).run();
  const row = { userId: "u1", dimension: "kind" as const, key: "stock", weightBp: 6000 };
  db.insert(allocationTargets).values(row).run();

  // A second target for the same slice is a contradiction, not an update: the
  // set is replaced wholesale (Task 5), never accumulated into.
  expect(() => db.insert(allocationTargets).values(row).run()).toThrow();
});
```

- [ ] **Step 4: Run** — `bun test src/server/db/schema.test.ts`.

- [ ] **Step 5: Commit** — `feat: a table for target allocations`

---

### Task 2: Targets as a domain type

**Files:**
- Create: `src/core/rebalance/targets.ts`, `src/core/rebalance/targets.test.ts`

**Interfaces:**
- Produces:

```typescript
export const BASIS_POINTS = 10_000;
export type Target = { readonly key: string; readonly weightBp: number };
export type TargetSet = { readonly dimension: Dimension; readonly targets: readonly Target[] };
export type TargetError = { readonly message: string; readonly totalBp: number };
/** `null` when the set is valid. */
export const checkTargets = (targets: readonly Target[]) => TargetError | null;
```

- [ ] **Step 1: Write the failing tests**

```typescript
test("a set summing to 100 % is accepted", () => {
  expect(checkTargets([{ key: "stock", weightBp: 6000 }, { key: "fund", weightBp: 4000 }])).toBeNull();
});

test("a set that does not sum to 100 % is refused, and the message says by how much", () => {
  // Refused rather than normalised: a set summing to 90 % means a slice was
  // forgotten, and inventing the missing tenth would hide that.
  const error = checkTargets([{ key: "stock", weightBp: 6000 }, { key: "fund", weightBp: 3000 }]);
  expect(error?.totalBp).toBe(9000);
  expect(error?.message).toContain("90");
});

test("a negative weight is refused", () => {
  expect(checkTargets([{ key: "stock", weightBp: 11000 }, { key: "fund", weightBp: -1000 }])).not.toBeNull();
});

test("an empty set is refused rather than treated as no targets", () => {
  // "I have no targets" is expressed by storing none at all; an empty set
  // arriving at this check is a caller bug.
  expect(checkTargets([])).not.toBeNull();
});
```

- [ ] **Step 2: Run and watch them fail** — the module does not exist.

- [ ] **Step 3: Implement.** Sum the weights as integers; reject a total other than `BASIS_POINTS`, any negative weight, and an empty list. The message is Finnish and states the actual total as a percentage.

- [ ] **Step 4: Run** — `bun test src/core/rebalance/targets.test.ts`.

- [ ] **Step 5: Commit** — `feat: target sets must sum to 100 %`

---

### Task 3: Drift

**Files:**
- Create: `src/core/rebalance/drift.ts`, `src/core/rebalance/drift.test.ts`

**Interfaces:**
- Consumes: `AllocationResult` and `Slice` from `src/core/allocation.ts`; `Target` from Task 2.
- Produces:

```typescript
export const DEFAULT_BAND_BP = 500; // five percentage points

export type DriftRow = {
  readonly key: string;
  readonly label: string;
  readonly actualBp: number;
  /** Null when the slice has no target: untargeted is not the same as targeted at zero. */
  readonly targetBp: number | null;
  readonly driftBp: number | null;
  /** What would have to move to correct it. Positive means buy, negative means sell. */
  readonly driftEur: Money | null;
  readonly withinBand: boolean;
  readonly untargeted: boolean;
};

export type DriftReport = {
  readonly rows: readonly DriftRow[];
  readonly totalEur: Money;
  /** True when a holding could not be valued, so every row's drift is unknown. */
  readonly incomplete: boolean;
};

export const driftFor = (args: {
  readonly allocation: AllocationResult;
  readonly targets: readonly Target[];
  readonly bandBp?: number;
}) => DriftReport;
```

- [ ] **Step 1: Write the failing tests**

```typescript
test("reports drift in both percentage points and euros", () => {
  // 7 000 € of a 10 000 € portfolio in shares against a 60 % target: 10 points
  // over, and 1 000 € would have to move.
  const report = driftFor({
    allocation: allocationOf([slice("stock", "7000,00"), slice("fund", "3000,00")]),
    targets: [{ key: "stock", weightBp: 6000 }, { key: "fund", weightBp: 4000 }],
  });

  const shares = report.rows.find((row) => row.key === "stock")!;
  expect(shares.driftBp).toBe(1000);
  expect(formatMoney(shares.driftEur!)).toBe("-1000.00");
  expect(formatMoney(report.rows.find((row) => row.key === "fund")!.driftEur!)).toBe("1000.00");
});

test("a slice inside the band reads as on target but still carries its figure", () => {
  // Without a band every slice is always drifted by something, and a screen
  // that always says "drifted" trains the reader to ignore it.
  const report = driftFor({
    allocation: allocationOf([slice("stock", "6200,00"), slice("fund", "3800,00")]),
    targets: [{ key: "stock", weightBp: 6000 }, { key: "fund", weightBp: 4000 }],
  });

  const shares = report.rows.find((row) => row.key === "stock")!;
  expect(shares.withinBand).toBe(true);
  expect(shares.driftBp).toBe(200);
});

test("a slice with no target is untargeted, not targeted at zero", () => {
  // "I have not decided about this holding" and "I want none of it" are
  // different statements, and only the second implies a sale.
  const report = driftFor({
    allocation: allocationOf([slice("stock", "6000,00"), slice("cash", "4000,00")]),
    targets: [{ key: "stock", weightBp: 10000 }],
  });

  const cash = report.rows.find((row) => row.key === "cash")!;
  expect(cash.untargeted).toBe(true);
  expect(cash.targetBp).toBeNull();
  expect(cash.driftBp).toBeNull();
});

test("an unvaluable holding suspends every row's drift, not only its own", () => {
  // A weight is a share of a total, so one unpriceable holding makes every
  // other slice's drift wrong by an unknown amount.
  const report = driftFor({
    allocation: { ...allocationOf([slice("stock", "6000,00")]), excludedInstrumentIds: [42] },
    targets: [{ key: "stock", weightBp: 10000 }],
  });

  expect(report.incomplete).toBe(true);
  expect(report.rows[0]!.driftEur).toBeNull();
});
```

- [ ] **Step 2: Run and watch them fail.**

- [ ] **Step 3: Implement.** `actualBp` is the slice's weight scaled to basis points, rounded half-up. `driftEur` is `(actualBp - targetBp) / BASIS_POINTS` of the total, as an exact integer ratio, **negated** so a positive figure means "buy this much" and a negative one "sell this much". `withinBand` is `|driftBp| <= bandBp`. Every row's money fields are null when `excludedInstrumentIds` is non-empty.

- [ ] **Step 4: Run** — `bun test src/core/rebalance/drift.test.ts`.

- [ ] **Step 5: Commit** — `feat: drift against a target allocation`

---

### Task 4: Where to put new money

**Files:**
- Create: `src/core/rebalance/deposit.ts`, `src/core/rebalance/deposit.test.ts`

**Interfaces:**
- Consumes: `DriftReport` from Task 3, `Target` from Task 2.
- Produces:

```typescript
export type DepositAllocation = { readonly key: string; readonly label: string; readonly amountEur: Money };
export const allocateDeposit = (args: {
  readonly rows: readonly DriftRow[];
  readonly targets: readonly Target[];
  readonly totalEur: Money;
  readonly depositEur: Money;
}) => readonly DepositAllocation[];
```

- [ ] **Step 1: Write the failing tests**

```typescript
test("fills the most underweight slice first", () => {
  // 7 000 in shares, 3 000 in funds, targets 60/40, depositing 1 000: after the
  // deposit the total is 11 000, so the fund target is 4 400 and it is 1 400
  // short -- the whole deposit goes there.
  const allocations = allocateDeposit({
    rows: driftRows,
    targets: [{ key: "stock", weightBp: 6000 }, { key: "fund", weightBp: 4000 }],
    totalEur: parseMoney("10000,00", EUR),
    depositEur: parseMoney("1000,00", EUR),
  });

  expect(allocations).toHaveLength(1);
  expect(allocations[0]!.key).toBe("fund");
  expect(formatMoney(allocations[0]!.amountEur)).toBe("1000.00");
});

test("measures the shortfall against the post-deposit total, not the current one", () => {
  // Adding money changes every weight: a slice exactly on target before the
  // deposit is underweight after it, and a rule measured on the old total
  // would direct nothing there.
  const allocations = allocateDeposit({
    rows: onTargetRows,
    targets: [{ key: "stock", weightBp: 5000 }, { key: "fund", weightBp: 5000 }],
    totalEur: parseMoney("10000,00", EUR),
    depositEur: parseMoney("1000,00", EUR),
  });

  expect(allocations.map((a) => formatMoney(a.amountEur)).sort()).toEqual(["500.00", "500.00"]);
});

test("the parts sum to exactly what was deposited", () => {
  // A split that loses a cent is a split that will not reconcile against the
  // deposit it describes.
  const allocations = allocateDeposit({
    rows: threeWayRows,
    targets: [
      { key: "a", weightBp: 3334 },
      { key: "b", weightBp: 3333 },
      { key: "c", weightBp: 3333 },
    ],
    totalEur: parseMoney("0,00", EUR),
    depositEur: parseMoney("100,01", EUR),
  });

  const total = allocations.reduce((sum, a) => addMoney(sum, a.amountEur), zeroMoney(EUR));
  expect(formatMoney(total)).toBe("100.01");
});

test("directs nothing to an untargeted slice", () => {
  const allocations = allocateDeposit({
    rows: rowsWithUntargetedCash,
    targets: [{ key: "stock", weightBp: 10000 }],
    totalEur: parseMoney("10000,00", EUR),
    depositEur: parseMoney("500,00", EUR),
  });

  expect(allocations.every((a) => a.key !== "cash")).toBe(true);
});
```

- [ ] **Step 2: Run and watch them fail.**

- [ ] **Step 3: Implement.** Compute each targeted slice's shortfall against `target × (totalEur + depositEur)`; drop slices already at or above it; distribute the deposit across the rest in proportion to their shortfalls, capped at each shortfall, largest allocation absorbing the rounding remainder so the parts sum to the deposit.

- [ ] **Step 4: Run** — `bun test src/core/rebalance/deposit.test.ts`.

- [ ] **Step 5: Commit** — `feat: direct a deposit at the widest gap`

---

### Task 5: The full rebalance plan

**Files:**
- Create: `src/core/rebalance/plan.ts`, `src/core/rebalance/plan.test.ts`

**Interfaces:**
- Consumes: `DriftRow` from Task 3; `Disposal`/`buildLots` from `src/core/costbasis.ts`.
- Produces:

```typescript
export const MIN_TRADE_EUR = 5_000n; // 50,00 € in minor units

export type Trade = {
  readonly key: string;
  readonly label: string;
  readonly side: "buy" | "sell";
  readonly amountEur: Money;
  /** For a sale: the gain FIFO would realise. Null when the cost basis is unknown. */
  readonly realisedGainEur: Money | null;
  readonly gainUnknown: boolean;
};

export type RebalancePlan = {
  readonly trades: readonly Trade[];
  /** Trades dropped for being below the floor -- listed, never hidden. */
  readonly tooSmall: readonly Trade[];
  readonly totalRealisedGainEur: Money;
  readonly balanced: boolean;
};

export const rebalancePlan = (args: {
  readonly rows: readonly DriftRow[];
  readonly gainOnSale: (key: string, amountEur: Money) => Money | null;
  readonly minTradeMinor?: bigint;
}) => RebalancePlan;
```

- [ ] **Step 1: Write the failing tests**

```typescript
test("sells the overweight and buys the underweight, and the two balance", () => {
  const plan = rebalancePlan({ rows: driftRows, gainOnSale: () => parseMoney("0,00", EUR) });
  const sells = plan.trades.filter((t) => t.side === "sell");
  const buys = plan.trades.filter((t) => t.side === "buy");

  // Self-funding: the plan spends exactly what it raises, so it needs no new
  // money and leaves no cash stranded.
  expect(sum(sells)).toEqual(sum(buys));
  expect(plan.balanced).toBe(true);
});

test("every sale names the gain it would realise", () => {
  // A tool that says "sell 4 000 € of X" without saying what that realises is
  // quietly recommending a taxable event.
  const plan = rebalancePlan({
    rows: driftRows,
    gainOnSale: () => parseMoney("1900,00", EUR),
  });

  const sale = plan.trades.find((t) => t.side === "sell")!;
  expect(formatMoney(sale.realisedGainEur!)).toBe("1900.00");
  expect(formatMoney(plan.totalRealisedGainEur)).toBe("1900.00");
});

test("a sale whose cost basis is unknown says so rather than claiming no gain", () => {
  const plan = rebalancePlan({ rows: driftRows, gainOnSale: () => null });
  const sale = plan.trades.find((t) => t.side === "sell")!;

  expect(sale.gainUnknown).toBe(true);
  expect(sale.realisedGainEur).toBeNull();
});

test("a trade below the floor is dropped and listed", () => {
  // Every broker charges a minimum commission, so a 3 € trade to correct
  // 0,2 pp of drift costs more than the drift -- but the owner may have a
  // reason to make one anyway, so it is shown, not hidden.
  const plan = rebalancePlan({ rows: tinyDriftRows, gainOnSale: () => parseMoney("0,00", EUR) });

  expect(plan.trades).toEqual([]);
  expect(plan.tooSmall).toHaveLength(2);
});

test("an untargeted slice is never traded", () => {
  const plan = rebalancePlan({ rows: rowsWithUntargetedCash, gainOnSale: () => parseMoney("0,00", EUR) });
  expect(plan.trades.every((t) => t.key !== "cash")).toBe(true);
});
```

- [ ] **Step 2: Run and watch them fail.**

- [ ] **Step 3: Implement.** A positive `driftEur` is a buy, a negative one a sale. Drop anything whose magnitude is below `minTradeMinor` into `tooSmall`. `gainOnSale` is injected so `core` stays free of the lot machinery's wiring; the server passes a closure over `buildLots`. `balanced` is true when the remaining buys and sells sum to the same figure.

- [ ] **Step 4: Run** — `bun test src/core/rebalance/plan.test.ts`.

- [ ] **Step 5: Commit** — `feat: a rebalance plan that names what each sale realises`

---

### Task 6: Fees

**Files:**
- Create: `src/core/rebalance/fees.ts`, `src/core/rebalance/fees.test.ts`

**Interfaces:**
- Produces:

```typescript
export type FeeYear = {
  readonly year: number;
  readonly tradeFeesEur: Money;
  readonly chargedFeesEur: Money;
  readonly totalEur: Money;
  /** Capital income tax withheld, excluded from the totals above and shown apart. */
  readonly withheldTaxEur: Money;
};

export const feesByYear = (args: {
  readonly txns: readonly Txn[];
  readonly ostAccountIds: ReadonlySet<number>;
}) => readonly FeeYear[];
```

- [ ] **Step 1: Write the failing tests**

```typescript
test("counts a trade's fee and a charged fee separately", () => {
  const [year] = feesByYear({
    txns: [
      buy("2025-03-10", { amount: "-1000,00", fee: "15,00" }),
      fee("2025-04-01", "2,50", 1),
    ],
    ostAccountIds: new Set(),
  });

  expect(formatMoney(year!.tradeFeesEur)).toBe("15.00");
  expect(formatMoney(year!.chargedFeesEur)).toBe("2.50");
  expect(formatMoney(year!.totalEur)).toBe("17.50");
});

test("capital income tax withheld on an equity savings account is not a fee", () => {
  // The broker books it as a fee row, for a good reason -- the money leaves
  // permanently without reaching the investor -- but it is not a cost of
  // investing, and in a real ledger it is most of the fee total in the years
  // it appears. Counting it makes fee drag meaningless.
  const [year] = feesByYear({
    txns: [fee("2025-10-21", "9,75", 7, "Internal to 12345678")],
    ostAccountIds: new Set([7]),
  });

  expect(formatMoney(year!.totalEur)).toBe("0.00");
  expect(formatMoney(year!.withheldTaxEur)).toBe("9.75");
});

test("an ordinary fee on an ordinary account is still a fee", () => {
  const [year] = feesByYear({
    txns: [fee("2025-04-01", "2,50", 1)],
    ostAccountIds: new Set([7]),
  });

  expect(formatMoney(year!.chargedFeesEur)).toBe("2.50");
  expect(formatMoney(year!.withheldTaxEur)).toBe("0.00");
});

test("years are reported newest first, and a year with no fees is absent", () => {
  const years = feesByYear({
    txns: [buy("2024-03-10", { amount: "-1000,00", fee: "15,00" }), buy("2025-03-10", { amount: "-1000,00", fee: "9,00" })],
    ostAccountIds: new Set(),
  });

  expect(years.map((y) => y.year)).toEqual([2025, 2024]);
});
```

- [ ] **Step 2: Run and watch them fail.**

- [ ] **Step 3: Implement.** Sum `t.fee` for every transaction into `tradeFeesEur`. For a `FEE`-typed transaction on an account in `ostAccountIds`, add the magnitude to `withheldTaxEur`; otherwise to `chargedFeesEur`. Convert with `toEur(..., t.fxRateEur)` throughout.

- [ ] **Step 4: Run** — `bun test src/core/rebalance/fees.test.ts`.

- [ ] **Step 5: Commit** — `feat: a fee report that does not count tax as a fee`

---

### Task 7: Server translation and routes

**Files:**
- Create: `src/server/rebalance.ts`, `src/server/rebalance.test.ts`, `src/server/api/rebalance.ts`, `src/server/api/rebalance.test.ts`
- Modify: `src/server/index.ts` (mount `rebalanceRoutes`)

**Interfaces:**
- Consumes: everything above; `loadPortfolio`, `cashFor` from `src/server/valuation.ts`.
- Produces: `targetsFor`, `saveTargets`, `driftReportFor`, `rebalancePlanFor`, `feeReportFor`, and the routes `GET/PUT /api/targets`, `GET /api/drift`, `GET /api/rebalance`, `GET /api/fees`.

- [ ] **Step 1: Write the failing route tests** — a signed-in caller saving a set that sums to 90 % gets 400 with the total named; a valid set replaces the previous one wholesale rather than accumulating; `GET /api/drift` returns decimal strings and names each slice; one user never sees another's targets; an anonymous caller gets 401.

- [ ] **Step 2: Run and watch them fail.**

- [ ] **Step 3: Implement.** `saveTargets` deletes the user's rows for that dimension and inserts the new set **in one transaction** — a half-applied set summing to 43 % must never be reachable. `rebalancePlanFor` builds the `gainOnSale` closure over `buildLots` for the user's own transactions.

- [ ] **Step 4: Run** — `bun test src/server/rebalance.test.ts src/server/api/rebalance.test.ts`.

- [ ] **Step 5: Commit** — `feat: target, drift, rebalance and fee routes`

---

### Task 8: The Tasapaino tab

**Files:**
- Create: `src/web/routes/rebalance.tsx`, `src/web/routes/rebalance-view.ts`
- Modify: `src/web/route-tree.ts`, `src/web/route-tree.test.ts`, `src/web/router.ts`, `src/web/routes/session-gate.tsx`

- [ ] **Step 1: Build the screen.** A dimension picker and target editor that refuses to save unless the weights sum to 100 %, showing the running total as you type. A drift table: target, actual, gap in points and euros, with an *tavoitteessa* badge inside the band and untargeted slices in their own group. A deposit box: enter an amount, see where it should go. A **Täysi tasapainotus** disclosure — collapsed by default — showing the trades, each sale with the gain it would realise, the total realised gain above the table, and the dropped too-small trades listed below it. A fee section per year with the withheld tax shown apart and labelled as not a fee.

- [ ] **Step 2: Verify by eye** — `bun run dev`: a portfolio with no targets, one with targets, and one with an unpriceable holding (drift must read unknown rather than zero).

- [ ] **Step 3: Add the route test** — the tab sits inside the session gate, like every other screen.

- [ ] **Step 4: Commit** — `feat: Tasapaino tab`

---

### Task 9: The chat tool and the docs

**Files:**
- Modify: `src/server/chat/tools.ts`, `src/server/chat/tools.test.ts`, `README.md`, `docs/HANDOVER.md`, `docs/superpowers/specs/2026-08-27-portfolio-manager-design.md`

- [ ] **Step 1: Add `get_drift`** — reads through `src/server/rebalance.ts`, returns each slice's target, actual and gap plus the fee totals, and carries a note saying it never recommends a trade and that a sale's figure is a gain, not a tax.

- [ ] **Step 2: Test it** — the tool returns the same figures the screen does, and its result contains no tax figure.

- [ ] **Step 3: README** — a Tasapaino row in the screens table, and a short section on targets, drift, the deposit rule and fees, including that withheld tax is excluded.

- [ ] **Step 4: HANDOVER** — add the module to "What exists"; add "a suggestion always states what it costs" and "tax withheld is not a fee" to the decisions list.

- [ ] **Step 5: Phase 1 spec** — a §10h amendment recording that phase 5 shipped and pointing at its spec.

- [ ] **Step 6: Commit** — `docs: phase 5 shipped`

---

## Self-review

**Spec coverage.** §3 targets → Tasks 1–2. §3.1 storage and wholesale replacement → Tasks 1 and 7. §4 drift, band, untargeted, unvaluable → Task 3. §5 deposit → Task 4. §6 full rebalance, minimum size, realised gain → Task 5. §7 fees and §7.1 the tax exclusion → Task 6. §8 module boundaries → Tasks 2–8, one file each. §9 testing → the tests in each task. §10 not-built → nothing to implement.

**Type consistency.** `DriftRow` is produced by Task 3 and consumed by Tasks 4, 5 and 8. `Target` comes from Task 2 and is used in Tasks 3, 4 and 7. `Trade.realisedGainEur` is null exactly when `gainUnknown` is true. `MIN_TRADE_EUR` and `DEFAULT_BAND_BP` are the only tunables, both overridable per call.

**Known risk, resolved in-task.** Task 5's `gainOnSale` is injected rather than computed in `core`, because a sale suggested at the slice level (e.g. "sell 1 000 € of funds") does not name which instrument to sell. The server closure attributes the sale across the slice's holdings largest-first and sums the FIFO gain; Task 7's test asserts that attribution against a two-instrument slice.

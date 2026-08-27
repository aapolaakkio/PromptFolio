# PromptFolio Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A self-hosted Bun + React app that imports Nordnet/OP transaction CSVs into an append-only ledger, values holdings daily from listed prices and Finnish fund NAVs, and shows portfolio value, growth and allocation.

**Architecture:** One Bun 1.4 process serves the JSON API, the React SPA and a `Bun.cron` price refresh. `Bun.serve`'s HTML routes bundle the SPA in-process, so there is no separate bundler. Domain logic lives in `src/core` as pure functions over plain data — no DB, no network, no floats for money. `src/server` owns SQLite, HTTP, importers and price sources; `src/web` is the SPA.

**Tech Stack:** Bun 1.4, TypeScript 7 (strict), oxlint + oxfmt with vendored anti-slop rules, Drizzle ORM `1.0.0-rc.5` on `drizzle-orm/bun-sqlite`, Better Auth `1.7.2`, `bun:test`, Zod, React 19, Tailwind CSS v4, TanStack Router / Query / Table / Charts.

**Spec:** `docs/superpowers/specs/2026-08-27-portfolio-manager-design.md`

## Global Constraints

- Bun 1.4. No Node, no npm scripts that shell out to `node`.
- **Prefer a Bun built-in over a dependency.** Specifically: `bun:sqlite` (not better-sqlite3), `Bun.password` (not argon2/bcrypt packages), `Bun.serve` HTML routes (not vite/webpack), `Bun.cron` (not node-cron), `Bun.CryptoHasher` (not crypto-js), `Bun.randomUUIDv7` (not uuid/nanoid), `Bun.file` / `Bun.write` (not fs), `Bun.Glob` (not glob/fast-glob), `Bun.$` (not execa), `bun:test` (not vitest/jest). A new dependency needs a reason a Bun API cannot cover.
- Lint is **oxlint** `1.80.0`, format is **oxfmt** `0.65.0`. No ESLint, no Prettier, no Biome.
- Styling is **Tailwind CSS v4** (`^4.3`) compiled by `bun-plugin-tailwind` inside Bun's HTML bundler. No PostCSS config, no `tailwind.config.js` - v4 configures itself from CSS. Design tokens live in one `@theme` block in `src/web/styles.css           Tailwind entry: @import, @theme tokens, @utility`; components use utility classes. The only hand-written CSS allowed is that `@theme` block and a small number of `@utility` definitions for genuinely repeated compositions.
- The **anti-slop** rule set (github.com/dmmulroy/anti-slop) is vendored into `tools/oxlint/anti-slop/` and every generic rule runs at `error`. It is designed to be vendored and edited, not depended on. Two of its rules shape how you write code here: `no-runtime-typeof` means boundary data is parsed with Zod rather than narrowed with ad hoc `typeof` checks, and `no-module-mocking` means tests use real seams and recorded fixtures rather than module mocks. Both already match this plan; do not weaken a rule to make code pass — change the code.
- **Dependency policy: take the newest prerelease when it is ahead of stable, otherwise stable.** As of 2026-08-27 that means Drizzle only. Verified: Better Auth (stable 1.7.2 > rc 1.7.0-rc.6), every TanStack package, Zod, ESLint and TypeScript all have `latest` ahead of their alpha/beta/rc tags, so they take stable.
- Drizzle is pinned to the newest RC builds: `drizzle-orm@1.0.0-rc.5-169397b` and `drizzle-kit@1.0.0-rc.5-ab785fc`. Pin exactly, no caret — RC-to-RC changes are not semver-safe. These are the `rc5` dist-tag builds and carry different commit hashes per package; if `drizzle-kit generate` produces migrations `drizzle-orm` then rejects at runtime, that mismatch is the first suspect — drop both to the plain `rc` tag (`1.0.0-rc.4`) and re-run Task 7.
- Auth is Better Auth `1.7.2` with its Drizzle adapter and `Bun.password` as the hashing backend. Do not hand-roll session handling.
- TypeScript `strict: true`. No `any` in `src/core`.
- **Money is never a float.** `Money` is `{ minor: bigint, currency }`; `Quantity` is a bigint scaled by 10^6; `FxRate` is a bigint scaled by 10^8. Rates of return (XIRR, TWR) are the only `number` values, and only because they are ratios, never amounts.
- `src/core` must not import from `src/server` or `src/web`. Enforced by a lint rule in Task 1.
- Transactions are append-only. No `UPDATE` or `DELETE` on `transactions` except the import-undo path (Task 12).
- Zod validation at every boundary: HTTP bodies, CSV parser output, price-source responses.
- All UI amounts render `fi-FI`: decimal comma, non-breaking-space thousands, EUR.
- No live network calls in the test suite. Ever. Price sources are tested against recorded fixtures.
- Test coverage target 80%, enforced in CI from Task 1 onward.
- Every task ends with a commit. Conventional Commits format, no attribution trailer.

---

## File Structure

```
src/core/money.ts            Money, Quantity, FxRate; arithmetic and parsing
src/core/types.ts            Shared domain types (Txn, Instrument, Position, ...)
src/core/ledger.ts           positionsAt, cashAt, holdingsAt
src/core/costbasis.ts        FIFO lots, disposals, unrealised gain
src/core/returns.ts          valueSeries, xirr, twr
src/core/allocation.ts       allocateBy
src/core/reconcile.ts        (phase 2 — not in this plan)

src/server/db/schema.ts      Drizzle table definitions (app + better-auth)
src/server/db/index.ts       bun:sqlite handle, drizzle client, migrate()
src/server/db/queries.ts     Typed query helpers over drizzle
src/server/auth.ts           Better Auth instance, Bun.password hashing
src/server/auth-guard.ts     requireUser(req) -> session or 401
src/server/import/types.ts   RawRow, Draft, ImporterConfig
src/server/import/csv.ts     Generic CSV parse driven by broker config
src/server/import/brokers.ts Nordnet + OP config objects
src/server/import/map.ts     RawRow[] -> Draft
src/server/import/commit.ts  Draft -> ledger rows, dedupe, undo
src/server/prices/types.ts   PriceSource interface
src/server/prices/yahoo.ts   Listed securities
src/server/prices/funds.ts   Nordnet/OP/S-Pankki/Danske NAV sources
src/server/prices/registry.ts Source lookup by instrument
src/server/prices/refresh.ts  Daily refresh, backfill, fetch log
src/server/fx.ts             ECB reference rates
src/server/valuation.ts      Assembles core/* over DB rows
src/server/api/*.ts          Route modules
src/server/index.ts          Bun.serve + Bun.cron entrypoint

src/web/index.html           SPA shell, imported by Bun.serve routes
src/web/main.tsx             SPA entry, router, query client
src/web/lib/auth-client.ts   Better Auth react client
src/web/lib/format.ts        fi-FI formatting
src/web/lib/api.ts           Typed fetch wrappers
src/web/charts/*.tsx         TimeSeriesChart, AllocationChart, BarChart
src/web/routes/*.tsx         dashboard, holdings, imports, login
```

---

### Task 1: Project scaffold and toolchain

**Files:**
- Create: `package.json`, `tsconfig.json`, `bunfig.toml`, `eslint.config.js`, `.gitignore`
- Create: `src/core/version.ts`
- Test: `src/core/version.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `bun test`, `bun run typecheck`, `bun run lint` all work; the layering lint rule that every later task depends on.

- [ ] **Step 1: Initialise the project**

```bash
bun init -y
rm -f index.ts
mkdir -p src/core src/server src/web docs/superpowers
```

Replace `package.json` with:

```json
{
  "name": "promptfolio",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "bun --hot src/server/index.ts",
    "start": "NODE_ENV=production bun src/server/index.ts",
    "build": "bun build --production --outdir dist --plugin bun-plugin-tailwind src/web/index.html",
    "db:generate": "drizzle-kit generate",
    "test": "bun test",
    "test:cov": "bun test --coverage",
    "typecheck": "tsc --noEmit",
    "lint": "oxlint",
    "fmt": "oxfmt src",
    "fmt:check": "oxfmt --check src",
    "check": "bun run lint && bun run fmt:check && bun run typecheck && bun test"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^7",
    "oxlint": "1.80.0",
    "@oxlint/plugins": "1.80.0",
    "oxfmt": "0.65.0",
    "bun-plugin-tailwind": "^0.1.2",
    "@better-auth/cli": "1.5.0-beta.13",
    "drizzle-kit": "1.0.0-rc.5-ab785fc"
  },
  "dependencies": {
    "zod": "^4",
    "drizzle-orm": "1.0.0-rc.5-169397b",
    "better-auth": "1.7.2",
    "@better-auth/drizzle-adapter": "1.7.2",
    "react": "^19",
    "react-dom": "^19",
    "@tanstack/react-router": "^1.170",
    "@tanstack/react-query": "^5.102",
    "@tanstack/react-table": "^9.2",
    "@tanstack/react-charts": "^0.16",
    "tailwindcss": "^4.3"
  }
}
```

Run `bun install`. Note there is **no bundler dependency** — `Bun.serve` bundles the SPA from an
HTML import, and `bun build` handles the production output. If `bun install` resolves
`drizzle-orm` or `drizzle-kit` to `0.45.x`, the pin was dropped — both must read their exact
`1.0.0-rc.5-*` build in `package.json`, with no caret.

Verify the pins took:

```bash
bun pm ls | grep -E 'drizzle|better-auth'
```

Expected: `drizzle-orm@1.0.0-rc.5-169397b`, `drizzle-kit@1.0.0-rc.5-ab785fc`, `better-auth@1.7.2`, `@better-auth/cli@1.5.0-beta.13` (its beta is ahead of stable 1.4.21, so the prerelease policy takes it; the runtime packages' stable 1.7.2 is ahead of their 1.7.0 rc, so those stay stable).

- [ ] **Step 2: Configure TypeScript strictly**

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "lib": ["ESNext", "DOM", "DOM.Iterable"],
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "types": ["bun-types"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src"]
}
```

`bunfig.toml`:

```toml
[test]
coverage = true
coverageThreshold = 0.8

# Bun's HTML bundler runs Tailwind directly - no vite, no postcss config.
[serve.static]
plugins = ["bun-plugin-tailwind"]
```

- [ ] **Step 3: Write the failing test**

`src/core/version.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { VERSION } from './version'

test('exposes a semver version string', () => {
  expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/)
})
```

- [ ] **Step 4: Run it and watch it fail**

Run: `bun test src/core/version.test.ts`
Expected: FAIL — `Cannot find module './version'`.

- [ ] **Step 5: Make it pass**

`src/core/version.ts`:

```ts
export const VERSION = '0.1.0'
```

Run: `bun test src/core/version.test.ts` → PASS.

- [ ] **Step 6: Vendor the anti-slop rules and configure oxlint**

Vendor the plugin — it is meant to be copied and owned, not installed:

```bash
mkdir -p tools/oxlint
bunx degit dmmulroy/anti-slop/src tools/oxlint/anti-slop
```

If `degit` is unavailable, clone and copy instead:

```bash
git clone --depth 1 https://github.com/dmmulroy/anti-slop /tmp/anti-slop \
  && cp -R /tmp/anti-slop/src tools/oxlint/anti-slop \
  && rm -rf /tmp/anti-slop
```

`oxlint.config.ts`:

```ts
import { defineConfig } from 'oxlint'

export default defineConfig({
  ignorePatterns: [
    '.claude/**',
    'dist/**',
    'drizzle/**',
    'tools/oxlint/anti-slop/**',
  ],
  jsPlugins: [
    { name: 'anti-slop', specifier: './tools/oxlint/anti-slop/index.ts' },
  ],
  rules: {
    'anti-slop/no-chained-type-assertions': 'error',
    'anti-slop/no-conditional-empty-object-spread': 'error',
    'anti-slop/no-known-value-widening': 'error',
    'anti-slop/no-module-mocking': 'error',
    'anti-slop/no-object-parameters': 'error',
    'anti-slop/no-reflect-apply': 'error',
    'anti-slop/no-reflect-get': 'error',
    'anti-slop/no-runtime-typeof': 'error',
    'anti-slop/no-shape-in-symbol-names': 'error',
    'anti-slop/no-unknown-parameters': 'error',
    'anti-slop/no-unknown-returns': 'error',
    'anti-slop/no-unknown-type-aliases': 'error',
    'anti-slop/no-unsafe-dictionary-type': 'error',
    'anti-slop/no-widen-then-assert': 'error',
    'anti-slop/require-safety-comment-for-type-assertion': 'error',
    'typescript/no-explicit-any': 'error',
  },
})
```

Skip the optional `anti-slop-effect` plugin — this project does not use Effect.

Run: `bun run lint`, `bun run fmt`, `bun run typecheck`. All must pass.

- [ ] **Step 7: Enforce the core/server layering with a test, not a lint rule**

`src/core/layering.test.ts`:

```ts
import { test, expect } from 'bun:test'

const FORBIDDEN = /from\s+['"](.*\/(server|web)\/|bun:sqlite|drizzle-orm|better-auth)/

test('src/core imports nothing from server, web, or a database', async () => {
  const offenders: string[] = []
  for await (const path of new Bun.Glob('src/core/**/*.ts').scan('.')) {
    const source = await Bun.file(path).text()
    for (const [index, line] of source.split('\n').entries()) {
      if (FORBIDDEN.test(line)) offenders.push(`${path}:${index + 1}: ${line.trim()}`)
    }
  }
  expect(offenders).toEqual([])
})
```

Run: `bun test src/core/layering.test.ts` → PASS (nothing in `src/core` violates it yet). This
test is the guard every later task relies on; it fails loudly the first time someone reaches for
the database from a pure module.

- [ ] **Step 8: Add the Drizzle config**

`drizzle.config.ts`:

```ts
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/server/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url: Bun.env.DATABASE_PATH ?? './data/promptfolio.db' },
})
```

`.gitignore` must contain `node_modules`, `dist`, `data`, `*.db`, `*.db-wal`, `*.db-shm`.
Commit the generated `drizzle/` migration folder and `tools/oxlint/anti-slop/` — migrations and
vendored rules are source, not build output.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "chore: scaffold bun project with drizzle rc, oxlint anti-slop and core layering test"
```

---

### Task 2: `core/money` — exact money and quantity arithmetic

**Files:**
- Create: `src/core/money.ts`
- Test: `src/core/money.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `type Currency = 'EUR' | 'USD'`
  - `type Money = { readonly minor: bigint; readonly currency: Currency }`
  - `type Quantity = { readonly scaled: bigint }` (scale `10n ** 6n`)
  - `type FxRate = { readonly scaled: bigint; readonly currency: Currency }` (scale `10n ** 8n`)
  - `money(minor: bigint, currency: Currency): Money`
  - `parseMoney(text: string, currency: Currency): Money`
  - `formatMoney(m: Money): string` — plain `-1234.56`, no locale
  - `addMoney(a: Money, b: Money): Money`, `subMoney`, `negateMoney`
  - `mulMoney(m: Money, q: Quantity, mode?: Rounding): Money`
  - `divMoney(m: Money, divisor: bigint, mode?: Rounding): Money`
  - `zeroMoney(currency: Currency): Money`
  - `parseQuantity(text: string): Quantity`, `addQuantity`, `subQuantity`, `isZeroQuantity`, `cmpQuantity`
  - `toEur(m: Money, rate: FxRate, mode?: Rounding): Money`
  - `type Rounding = 'half-up' | 'floor'` (default `'half-up'`)

- [ ] **Step 1: Write the failing tests**

`src/core/money.test.ts`:

```ts
import { test, expect } from 'bun:test'
import {
  parseMoney, formatMoney, addMoney, subMoney, mulMoney, divMoney,
  parseQuantity, addQuantity, toEur, zeroMoney, money,
} from './money'

test('parses Finnish and plain decimal strings', () => {
  expect(parseMoney('1 234,56', 'EUR').minor).toBe(123456n)
  expect(parseMoney('1234.56', 'EUR').minor).toBe(123456n)
  expect(parseMoney('-0,07', 'EUR').minor).toBe(-7n)
  expect(parseMoney('12', 'EUR').minor).toBe(1200n)
})

test('rejects malformed amounts instead of guessing', () => {
  expect(() => parseMoney('', 'EUR')).toThrow()
  expect(() => parseMoney('1,234,567', 'EUR')).toThrow()
  expect(() => parseMoney('abc', 'EUR')).toThrow()
})

test('formats back without loss', () => {
  expect(formatMoney(parseMoney('1234,56', 'EUR'))).toBe('1234.56')
  expect(formatMoney(money(-7n, 'EUR'))).toBe('-0.07')
  expect(formatMoney(zeroMoney('EUR'))).toBe('0.00')
})

test('refuses to add across currencies', () => {
  expect(() => addMoney(parseMoney('1', 'EUR'), parseMoney('1', 'USD'))).toThrow(/currency/i)
})

test('adds and subtracts exactly', () => {
  const a = parseMoney('0,10', 'EUR')
  const b = parseMoney('0,20', 'EUR')
  expect(formatMoney(addMoney(a, b))).toBe('0.30')
  expect(formatMoney(subMoney(a, b))).toBe('-0.10')
})

test('multiplies price by fractional quantity, half-up', () => {
  const price = parseMoney('12,345', 'EUR')      // 12.35 after parse rounding
  expect(formatMoney(price)).toBe('12.35')
  const qty = parseQuantity('3,5')
  expect(formatMoney(mulMoney(parseMoney('10,00', 'EUR'), qty))).toBe('35.00')
  expect(formatMoney(mulMoney(parseMoney('0,01', 'EUR'), parseQuantity('0,5')))).toBe('0.01')
})

test('divides with explicit rounding mode', () => {
  const m = parseMoney('1,00', 'EUR')
  expect(formatMoney(divMoney(m, 3n))).toBe('0.33')
  expect(formatMoney(divMoney(parseMoney('0,05', 'EUR'), 2n, 'floor'))).toBe('0.02')
  expect(formatMoney(divMoney(parseMoney('0,05', 'EUR'), 2n, 'half-up'))).toBe('0.03')
})

test('parses fractional fund units at 10^-6 precision', () => {
  expect(parseQuantity('12,3456789').scaled).toBe(12345679n)
  expect(addQuantity(parseQuantity('1,5'), parseQuantity('0,25')).scaled).toBe(1750000n)
})

test('converts USD to EUR at a scaled rate', () => {
  const usd = parseMoney('100,00', 'USD')
  const rate = { scaled: 92_000_000n, currency: 'USD' as const }   // 1 USD = 0.92 EUR
  const eur = toEur(usd, rate)
  expect(eur.currency).toBe('EUR')
  expect(formatMoney(eur)).toBe('92.00')
})

test('refuses to convert with a rate for the wrong currency', () => {
  const usd = parseMoney('100,00', 'USD')
  expect(() => toEur(usd, { scaled: 1n, currency: 'EUR' })).toThrow(/currency/i)
})
```

- [ ] **Step 2: Run and watch them fail**

Run: `bun test src/core/money.test.ts`
Expected: FAIL — `Cannot find module './money'`.

- [ ] **Step 3: Implement**

`src/core/money.ts`:

```ts
export type Currency = 'EUR' | 'USD'
export type Rounding = 'half-up' | 'floor'

export type Money = { readonly minor: bigint; readonly currency: Currency }
export type Quantity = { readonly scaled: bigint }
export type FxRate = { readonly scaled: bigint; readonly currency: Currency }

const MONEY_SCALE = 2
export const QUANTITY_SCALE = 6
export const FX_SCALE = 8

export const money = (minor: bigint, currency: Currency): Money => ({ minor, currency })
export const zeroMoney = (currency: Currency): Money => ({ minor: 0n, currency })
export const quantity = (scaled: bigint): Quantity => ({ scaled })

/** Parses "1 234,56", "1234.56", "-0,07". Rejects anything else. */
const parseScaled = (text: string, scale: number): bigint => {
  const cleaned = text.replace(/[\s  ]/g, '').replace(',', '.')
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) {
    throw new Error(`Not a decimal number: ${JSON.stringify(text)}`)
  }
  const negative = cleaned.startsWith('-')
  const [whole = '0', frac = ''] = cleaned.replace('-', '').split('.')
  const padded = (frac + '0'.repeat(scale + 1)).slice(0, scale + 1)
  const scaledUp = BigInt(whole + padded.slice(0, scale))
  const roundUp = Number(padded[scale]) >= 5 ? 1n : 0n
  const value = scaledUp + roundUp
  return negative ? -value : value
}

export const parseMoney = (text: string, currency: Currency): Money =>
  ({ minor: parseScaled(text, MONEY_SCALE), currency })

export const parseQuantity = (text: string): Quantity =>
  ({ scaled: parseScaled(text, QUANTITY_SCALE) })

export const parseFxRate = (text: string, currency: Currency): FxRate =>
  ({ scaled: parseScaled(text, FX_SCALE), currency })

const formatScaled = (value: bigint, scale: number): string => {
  const negative = value < 0n
  const digits = (negative ? -value : value).toString().padStart(scale + 1, '0')
  const whole = digits.slice(0, digits.length - scale)
  const frac = digits.slice(digits.length - scale)
  return `${negative ? '-' : ''}${whole}.${frac}`
}

export const formatMoney = (m: Money): string => formatScaled(m.minor, MONEY_SCALE)
export const formatQuantity = (q: Quantity): string => formatScaled(q.scaled, QUANTITY_SCALE)

const sameCurrency = (a: Money, b: Money): void => {
  if (a.currency !== b.currency) {
    throw new Error(`Currency mismatch: ${a.currency} vs ${b.currency}`)
  }
}

export const addMoney = (a: Money, b: Money): Money => {
  sameCurrency(a, b)
  return { minor: a.minor + b.minor, currency: a.currency }
}

export const subMoney = (a: Money, b: Money): Money => {
  sameCurrency(a, b)
  return { minor: a.minor - b.minor, currency: a.currency }
}

export const negateMoney = (m: Money): Money => ({ minor: -m.minor, currency: m.currency })

/** Divide `value` by `divisor`, both bigint, applying an explicit rounding mode. */
const divideRounded = (value: bigint, divisor: bigint, mode: Rounding): bigint => {
  if (divisor === 0n) throw new Error('Division by zero')
  const negative = (value < 0n) !== (divisor < 0n)
  const a = value < 0n ? -value : value
  const b = divisor < 0n ? -divisor : divisor
  const q = a / b
  const r = a % b
  let result = q
  if (mode === 'half-up' && r * 2n >= b) result = q + 1n
  return negative ? -result : result
}

export const mulMoney = (m: Money, q: Quantity, mode: Rounding = 'half-up'): Money =>
  ({ minor: divideRounded(m.minor * q.scaled, 10n ** BigInt(QUANTITY_SCALE), mode), currency: m.currency })

export const divMoney = (m: Money, divisor: bigint, mode: Rounding = 'half-up'): Money =>
  ({ minor: divideRounded(m.minor, divisor, mode), currency: m.currency })

export const addQuantity = (a: Quantity, b: Quantity): Quantity => ({ scaled: a.scaled + b.scaled })
export const subQuantity = (a: Quantity, b: Quantity): Quantity => ({ scaled: a.scaled - b.scaled })
export const isZeroQuantity = (q: Quantity): boolean => q.scaled === 0n
export const cmpQuantity = (a: Quantity, b: Quantity): number =>
  a.scaled === b.scaled ? 0 : a.scaled < b.scaled ? -1 : 1

export const toEur = (m: Money, rate: FxRate, mode: Rounding = 'half-up'): Money => {
  if (m.currency === 'EUR') return m
  if (rate.currency !== m.currency) {
    throw new Error(`Fx rate currency ${rate.currency} does not match amount currency ${m.currency}`)
  }
  return {
    minor: divideRounded(m.minor * rate.scaled, 10n ** BigInt(FX_SCALE), mode),
    currency: 'EUR',
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test src/core/money.test.ts` → all PASS. Then `bun run typecheck` and `bun run lint`.

- [ ] **Step 5: Commit**

```bash
git add src/core/money.ts src/core/money.test.ts
git commit -m "feat: exact money, quantity and fx arithmetic on bigint"
```

---

### Task 3: `core/types` and `core/ledger` — positions from an append-only ledger

**Files:**
- Create: `src/core/types.ts`, `src/core/ledger.ts`
- Test: `src/core/ledger.test.ts`

**Interfaces:**
- Consumes: `core/money` (Task 2)
- Produces:
  - `type TransactionType = 'BUY'|'SELL'|'DIVIDEND'|'FEE'|'INTEREST'|'DEPOSIT'|'WITHDRAWAL'|'SPLIT'|'TRANSFER_IN'|'TRANSFER_OUT'`
  - `type IsoDate = string` (`yyyy-mm-dd`)
  - `type Txn` (fields below)
  - `type Instrument = { id: number; isin: string; ticker: string | null; name: string; kind: InstrumentKind; currency: Currency; priceSource: PriceSourceId; sourceKey: string }`
  - `type InstrumentKind = 'stock' | 'etf' | 'fund' | 'cash'`
  - `type PriceSourceId = 'yahoo'|'nordnet_fund'|'op_fund'|'spankki_fund'|'danske_fund'|'manual'`
  - `positionsAt(txns: Txn[], on: IsoDate): Map<number, Quantity>`
  - `cashAt(txns: Txn[], on: IsoDate, currency: Currency): Money`
  - `externalCashFlows(txns: Txn[]): CashFlow[]` where `CashFlow = { date: IsoDate; amountEur: Money }`, positive into the portfolio

`Txn` shape (used verbatim by Tasks 4, 5, 6, 12, 16):

```ts
export type Txn = {
  readonly id: number
  readonly accountId: number
  readonly instrumentId: number | null
  readonly type: TransactionType
  readonly tradeDate: IsoDate
  readonly quantity: Quantity      // always non-negative; direction comes from `type`
  readonly unitPrice: Money | null
  readonly amount: Money           // signed cash effect on the account, in `currency`
  readonly fee: Money
  readonly tax: Money
  readonly currency: Currency
  readonly fxRateEur: FxRate
}
```

- [ ] **Step 1: Write the failing tests**

`src/core/ledger.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { positionsAt, cashAt, externalCashFlows } from './ledger'
import type { Txn, TransactionType } from './types'
import { parseMoney, parseQuantity, parseFxRate, formatMoney, formatQuantity } from './money'

let nextId = 1
const txn = (
  type: TransactionType, tradeDate: string,
  opts: { instrumentId?: number; qty?: string; amount?: string; currency?: 'EUR' | 'USD'; rate?: string } = {},
): Txn => ({
  id: nextId++,
  accountId: 1,
  instrumentId: opts.instrumentId ?? null,
  type,
  tradeDate,
  quantity: parseQuantity(opts.qty ?? '0'),
  unitPrice: null,
  amount: parseMoney(opts.amount ?? '0', opts.currency ?? 'EUR'),
  fee: parseMoney('0', opts.currency ?? 'EUR'),
  tax: parseMoney('0', opts.currency ?? 'EUR'),
  currency: opts.currency ?? 'EUR',
  fxRateEur: parseFxRate(opts.rate ?? '1', opts.currency ?? 'EUR'),
})

test('accumulates buys and sells into positions', () => {
  const txns = [
    txn('BUY', '2025-01-10', { instrumentId: 7, qty: '10', amount: '-1000,00' }),
    txn('BUY', '2025-02-10', { instrumentId: 7, qty: '5', amount: '-520,00' }),
    txn('SELL', '2025-03-10', { instrumentId: 7, qty: '3', amount: '330,00' }),
  ]
  const pos = positionsAt(txns, '2025-12-31')
  expect(formatQuantity(pos.get(7)!)).toBe('12.000000')
})

test('ignores transactions after the as-of date', () => {
  const txns = [
    txn('BUY', '2025-01-10', { instrumentId: 7, qty: '10', amount: '-1000,00' }),
    txn('BUY', '2025-06-10', { instrumentId: 7, qty: '5', amount: '-520,00' }),
  ]
  expect(formatQuantity(positionsAt(txns, '2025-03-01').get(7)!)).toBe('10.000000')
})

test('omits instruments whose position has closed', () => {
  const txns = [
    txn('BUY', '2025-01-10', { instrumentId: 7, qty: '10', amount: '-1000,00' }),
    txn('SELL', '2025-02-10', { instrumentId: 7, qty: '10', amount: '1100,00' }),
  ]
  expect(positionsAt(txns, '2025-12-31').has(7)).toBe(false)
})

test('transfers in and out move units without cash', () => {
  const txns = [
    txn('TRANSFER_IN', '2020-01-02', { instrumentId: 9, qty: '100' }),
    txn('TRANSFER_OUT', '2021-01-02', { instrumentId: 9, qty: '40' }),
  ]
  expect(formatQuantity(positionsAt(txns, '2025-01-01').get(9)!)).toBe('60.000000')
  expect(formatMoney(cashAt(txns, '2025-01-01', 'EUR'))).toBe('0.00')
})

test('a split multiplies units and leaves cash alone', () => {
  const txns = [
    txn('BUY', '2025-01-10', { instrumentId: 7, qty: '10', amount: '-1000,00' }),
    // SPLIT quantity carries the resulting total units, not a delta
    txn('SPLIT', '2025-05-10', { instrumentId: 7, qty: '40' }),
  ]
  expect(formatQuantity(positionsAt(txns, '2025-12-31').get(7)!)).toBe('40.000000')
})

test('sums cash per currency', () => {
  const txns = [
    txn('DEPOSIT', '2025-01-01', { amount: '5000,00' }),
    txn('BUY', '2025-01-10', { instrumentId: 7, qty: '10', amount: '-1000,00' }),
    txn('DIVIDEND', '2025-04-10', { instrumentId: 7, amount: '35,50' }),
    txn('FEE', '2025-04-10', { amount: '-2,90' }),
    txn('BUY', '2025-05-10', { instrumentId: 8, qty: '2', amount: '-300,00', currency: 'USD', rate: '0,92' }),
  ]
  expect(formatMoney(cashAt(txns, '2025-12-31', 'EUR'))).toBe('4032.60')
  expect(formatMoney(cashAt(txns, '2025-12-31', 'USD'))).toBe('-300.00')
})

test('external cash flows are deposits and withdrawals only, in EUR', () => {
  const txns = [
    txn('DEPOSIT', '2025-01-01', { amount: '5000,00' }),
    txn('BUY', '2025-01-10', { instrumentId: 7, qty: '10', amount: '-1000,00' }),
    txn('WITHDRAWAL', '2025-09-01', { amount: '-500,00' }),
    txn('DEPOSIT', '2025-10-01', { amount: '1000,00', currency: 'USD', rate: '0,92' }),
  ]
  const flows = externalCashFlows(txns)
  expect(flows.map((f) => f.date)).toEqual(['2025-01-01', '2025-09-01', '2025-10-01'])
  expect(flows.map((f) => formatMoney(f.amountEur))).toEqual(['5000.00', '-500.00', '920.00'])
})
```

- [ ] **Step 2: Run and watch them fail**

Run: `bun test src/core/ledger.test.ts`
Expected: FAIL — missing modules `./ledger` and `./types`.

- [ ] **Step 3: Write `src/core/types.ts`**

```ts
import type { Currency, FxRate, Money, Quantity } from './money'

export type IsoDate = string

export type TransactionType =
  | 'BUY' | 'SELL' | 'DIVIDEND' | 'FEE' | 'INTEREST'
  | 'DEPOSIT' | 'WITHDRAWAL' | 'SPLIT' | 'TRANSFER_IN' | 'TRANSFER_OUT'

export type InstrumentKind = 'stock' | 'etf' | 'fund' | 'cash'

export type PriceSourceId =
  | 'yahoo' | 'nordnet_fund' | 'op_fund' | 'spankki_fund' | 'danske_fund' | 'manual'

export type Instrument = {
  readonly id: number
  readonly isin: string
  readonly ticker: string | null
  readonly name: string
  readonly kind: InstrumentKind
  readonly currency: Currency
  readonly priceSource: PriceSourceId
  readonly sourceKey: string
}

export type Txn = {
  readonly id: number
  readonly accountId: number
  readonly instrumentId: number | null
  readonly type: TransactionType
  readonly tradeDate: IsoDate
  readonly quantity: Quantity
  readonly unitPrice: Money | null
  readonly amount: Money
  readonly fee: Money
  readonly tax: Money
  readonly currency: Currency
  readonly fxRateEur: FxRate
}

export type CashFlow = { readonly date: IsoDate; readonly amountEur: Money }

export type PricePoint = { readonly date: IsoDate; readonly close: Money }
```

- [ ] **Step 4: Write `src/core/ledger.ts`**

```ts
import {
  addMoney, addQuantity, isZeroQuantity, subQuantity, toEur, zeroMoney,
  type Currency, type Money, type Quantity,
} from './money'
import type { CashFlow, IsoDate, Txn } from './types'

/** Sign a transaction type applies to unit count. `null` means "not a unit movement". */
const unitDirection = (type: Txn['type']): 1 | -1 | null => {
  switch (type) {
    case 'BUY': case 'TRANSFER_IN': return 1
    case 'SELL': case 'TRANSFER_OUT': return -1
    default: return null
  }
}

const upTo = (txns: readonly Txn[], on: IsoDate): Txn[] =>
  txns.filter((t) => t.tradeDate <= on)
    .slice()
    .sort((a, b) => (a.tradeDate === b.tradeDate ? a.id - b.id : a.tradeDate < b.tradeDate ? -1 : 1))

export const positionsAt = (txns: readonly Txn[], on: IsoDate): Map<number, Quantity> => {
  const positions = new Map<number, Quantity>()
  for (const t of upTo(txns, on)) {
    if (t.instrumentId === null) continue
    const current = positions.get(t.instrumentId) ?? { scaled: 0n }
    if (t.type === 'SPLIT') {
      positions.set(t.instrumentId, t.quantity)
      continue
    }
    const direction = unitDirection(t.type)
    if (direction === null) continue
    positions.set(
      t.instrumentId,
      direction === 1 ? addQuantity(current, t.quantity) : subQuantity(current, t.quantity),
    )
  }
  for (const [id, qty] of positions) if (isZeroQuantity(qty)) positions.delete(id)
  return positions
}

export const cashAt = (txns: readonly Txn[], on: IsoDate, currency: Currency): Money =>
  upTo(txns, on)
    .filter((t) => t.currency === currency)
    .reduce((sum, t) => addMoney(sum, t.amount), zeroMoney(currency))

export const externalCashFlows = (txns: readonly Txn[]): CashFlow[] =>
  txns
    .filter((t) => t.type === 'DEPOSIT' || t.type === 'WITHDRAWAL')
    .slice()
    .sort((a, b) => (a.tradeDate === b.tradeDate ? a.id - b.id : a.tradeDate < b.tradeDate ? -1 : 1))
    .map((t) => ({ date: t.tradeDate, amountEur: toEur(t.amount, t.fxRateEur) }))
```

- [ ] **Step 5: Run the tests**

Run: `bun test src/core/ledger.test.ts` → all PASS. Then `bun run check`.

- [ ] **Step 6: Commit**

```bash
git add src/core/types.ts src/core/ledger.ts src/core/ledger.test.ts
git commit -m "feat: derive positions, cash and external cash flows from the ledger"
```

---

### Task 4: `core/costbasis` — FIFO lots and disposals

**Files:**
- Create: `src/core/costbasis.ts`
- Test: `src/core/costbasis.test.ts`

**Interfaces:**
- Consumes: `core/money` (Task 2), `core/types`, `core/ledger` (Task 3)
- Produces:
  - `type Lot = { instrumentId: number; acquiredOn: IsoDate; quantity: Quantity; costEur: Money }`
  - `type Disposal = { instrumentId: number; acquiredOn: IsoDate; soldOn: IsoDate; quantity: Quantity; proceedsEur: Money; costEur: Money; gainEur: Money }`
  - `buildLots(txns: Txn[]): { open: Lot[]; disposals: Disposal[] }`
  - `costBasisAt(txns: Txn[], on: IsoDate): Map<number, Money>`

Cost includes fees on acquisition and is reduced by fees on disposal, which is what Finnish
capital gains treatment expects. Everything is converted to EUR at the transaction's own frozen
rate.

- [ ] **Step 1: Write the failing tests**

`src/core/costbasis.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { buildLots, costBasisAt } from './costbasis'
import type { Txn, TransactionType } from './types'
import { parseMoney, parseQuantity, parseFxRate, formatMoney, formatQuantity } from './money'

let nextId = 1
const txn = (
  type: TransactionType, tradeDate: string,
  o: { qty?: string; amount?: string; fee?: string; currency?: 'EUR' | 'USD'; rate?: string } = {},
): Txn => ({
  id: nextId++, accountId: 1, instrumentId: 7, type, tradeDate,
  quantity: parseQuantity(o.qty ?? '0'),
  unitPrice: null,
  amount: parseMoney(o.amount ?? '0', o.currency ?? 'EUR'),
  fee: parseMoney(o.fee ?? '0', o.currency ?? 'EUR'),
  tax: parseMoney('0', o.currency ?? 'EUR'),
  currency: o.currency ?? 'EUR',
  fxRateEur: parseFxRate(o.rate ?? '1', o.currency ?? 'EUR'),
})

test('a single buy becomes one open lot including its fee', () => {
  const { open, disposals } = buildLots([
    txn('BUY', '2025-01-10', { qty: '10', amount: '-1000,00', fee: '3,00' }),
  ])
  expect(disposals).toHaveLength(0)
  expect(open).toHaveLength(1)
  expect(formatQuantity(open[0]!.quantity)).toBe('10.000000')
  expect(formatMoney(open[0]!.costEur)).toBe('1003.00')
})

test('a sale consumes the oldest lot first', () => {
  const { open, disposals } = buildLots([
    txn('BUY', '2025-01-10', { qty: '10', amount: '-1000,00' }),   // 100.00/unit
    txn('BUY', '2025-02-10', { qty: '10', amount: '-1200,00' }),   // 120.00/unit
    txn('SELL', '2025-03-10', { qty: '4', amount: '600,00' }),     // 150.00/unit
  ])
  expect(disposals).toHaveLength(1)
  expect(disposals[0]!.acquiredOn).toBe('2025-01-10')
  expect(formatMoney(disposals[0]!.costEur)).toBe('400.00')
  expect(formatMoney(disposals[0]!.proceedsEur)).toBe('600.00')
  expect(formatMoney(disposals[0]!.gainEur)).toBe('200.00')
  expect(open.map((l) => formatQuantity(l.quantity))).toEqual(['6.000000', '10.000000'])
})

test('a sale spanning two lots produces two disposals', () => {
  const { open, disposals } = buildLots([
    txn('BUY', '2025-01-10', { qty: '10', amount: '-1000,00' }),
    txn('BUY', '2025-02-10', { qty: '10', amount: '-1200,00' }),
    txn('SELL', '2025-03-10', { qty: '15', amount: '2250,00' }),   // 150.00/unit
  ])
  expect(disposals).toHaveLength(2)
  expect(disposals.map((d) => formatMoney(d.costEur))).toEqual(['1000.00', '600.00'])
  expect(disposals.map((d) => formatMoney(d.proceedsEur))).toEqual(['1500.00', '750.00'])
  expect(open.map((l) => formatQuantity(l.quantity))).toEqual(['5.000000'])
})

test('disposal fees reduce proceeds', () => {
  const { disposals } = buildLots([
    txn('BUY', '2025-01-10', { qty: '10', amount: '-1000,00' }),
    txn('SELL', '2025-03-10', { qty: '10', amount: '1200,00', fee: '5,00' }),
  ])
  expect(formatMoney(disposals[0]!.proceedsEur)).toBe('1195.00')
  expect(formatMoney(disposals[0]!.gainEur)).toBe('195.00')
})

test('USD purchases are stored at the frozen EUR rate of their trade date', () => {
  const { open } = buildLots([
    txn('BUY', '2025-01-10', { qty: '10', amount: '-1000,00', currency: 'USD', rate: '0,90' }),
  ])
  expect(formatMoney(open[0]!.costEur)).toBe('900.00')
})

test('selling more units than held is a domain error', () => {
  expect(() => buildLots([
    txn('BUY', '2025-01-10', { qty: '5', amount: '-500,00' }),
    txn('SELL', '2025-02-10', { qty: '6', amount: '700,00' }),
  ])).toThrow(/instrument 7.*2025-02-10/i)
})

test('a split rescales open lots without creating a disposal', () => {
  const { open, disposals } = buildLots([
    txn('BUY', '2025-01-10', { qty: '10', amount: '-1000,00' }),
    txn('SPLIT', '2025-05-10', { qty: '40' }),
  ])
  expect(disposals).toHaveLength(0)
  expect(formatQuantity(open[0]!.quantity)).toBe('40.000000')
  expect(formatMoney(open[0]!.costEur)).toBe('1000.00')
})

test('cost basis at a date sums the open lots', () => {
  const txns = [
    txn('BUY', '2025-01-10', { qty: '10', amount: '-1000,00' }),
    txn('BUY', '2025-02-10', { qty: '10', amount: '-1200,00' }),
    txn('SELL', '2025-03-10', { qty: '4', amount: '600,00' }),
  ]
  expect(formatMoney(costBasisAt(txns, '2025-01-31').get(7)!)).toBe('1000.00')
  expect(formatMoney(costBasisAt(txns, '2025-12-31').get(7)!)).toBe('1800.00')
})
```

- [ ] **Step 2: Run and watch them fail**

Run: `bun test src/core/costbasis.test.ts`
Expected: FAIL — `Cannot find module './costbasis'`.

- [ ] **Step 3: Implement**

`src/core/costbasis.ts`:

```ts
import {
  addMoney, cmpQuantity, divMoney, mulMoney, subMoney, toEur, zeroMoney,
  type Money, type Quantity,
} from './money'
import type { IsoDate, Txn } from './types'

export type Lot = {
  readonly instrumentId: number
  readonly acquiredOn: IsoDate
  readonly quantity: Quantity
  readonly costEur: Money
}

export type Disposal = {
  readonly instrumentId: number
  readonly acquiredOn: IsoDate
  readonly soldOn: IsoDate
  readonly quantity: Quantity
  readonly proceedsEur: Money
  readonly costEur: Money
  readonly gainEur: Money
}

const chronological = (txns: readonly Txn[]): Txn[] =>
  txns.slice().sort((a, b) => (a.tradeDate === b.tradeDate ? a.id - b.id : a.tradeDate < b.tradeDate ? -1 : 1))

/** Split a lot's cost proportionally: `taken / lot.quantity` of `lot.costEur`. */
const proportionalCost = (lot: Lot, taken: Quantity): Money =>
  divMoney(mulMoney(lot.costEur, taken), lot.quantity.scaled === 0n ? 1n : lot.quantity.scaled / 1000000n || 1n)

export const buildLots = (txns: readonly Txn[]): { open: Lot[]; disposals: Disposal[] } => {
  const openByInstrument = new Map<number, Lot[]>()
  const disposals: Disposal[] = []

  for (const t of chronological(txns)) {
    if (t.instrumentId === null) continue
    const lots = openByInstrument.get(t.instrumentId) ?? []

    if (t.type === 'BUY' || t.type === 'TRANSFER_IN') {
      const gross = toEur({ minor: -t.amount.minor, currency: t.currency }, t.fxRateEur)
      const feeEur = toEur(t.fee, t.fxRateEur)
      lots.push({
        instrumentId: t.instrumentId,
        acquiredOn: t.tradeDate,
        quantity: t.quantity,
        costEur: addMoney(gross.minor < 0n ? zeroMoney('EUR') : gross, feeEur),
      })
      openByInstrument.set(t.instrumentId, lots)
      continue
    }

    if (t.type === 'SPLIT') {
      const total = lots.reduce((sum, l) => sum + l.quantity.scaled, 0n)
      if (total === 0n) continue
      openByInstrument.set(t.instrumentId, lots.map((l) => ({
        ...l,
        quantity: { scaled: (l.quantity.scaled * t.quantity.scaled) / total },
      })))
      continue
    }

    if (t.type !== 'SELL' && t.type !== 'TRANSFER_OUT') continue

    const proceedsEur = subMoney(toEur(t.amount, t.fxRateEur), toEur(t.fee, t.fxRateEur))
    let remaining = t.quantity
    const held = lots.reduce((sum, l) => sum + l.quantity.scaled, 0n)
    if (held < remaining.scaled) {
      throw new Error(
        `Cannot dispose ${remaining.scaled} units of instrument ${t.instrumentId} on ${t.tradeDate}: only ${held} held`,
      )
    }

    while (remaining.scaled > 0n) {
      const lot = lots[0]!
      const takenScaled = lot.quantity.scaled <= remaining.scaled ? lot.quantity.scaled : remaining.scaled
      const taken: Quantity = { scaled: takenScaled }
      const costEur = takenScaled === lot.quantity.scaled
        ? lot.costEur
        : { minor: (lot.costEur.minor * takenScaled) / lot.quantity.scaled, currency: 'EUR' as const }
      const shareOfProceeds = { minor: (proceedsEur.minor * takenScaled) / t.quantity.scaled, currency: 'EUR' as const }

      disposals.push({
        instrumentId: t.instrumentId,
        acquiredOn: lot.acquiredOn,
        soldOn: t.tradeDate,
        quantity: taken,
        proceedsEur: shareOfProceeds,
        costEur,
        gainEur: subMoney(shareOfProceeds, costEur),
      })

      if (takenScaled === lot.quantity.scaled) lots.shift()
      else lots[0] = {
        ...lot,
        quantity: { scaled: lot.quantity.scaled - takenScaled },
        costEur: subMoney(lot.costEur, costEur),
      }
      remaining = { scaled: remaining.scaled - takenScaled }
    }
    openByInstrument.set(t.instrumentId, lots)
  }

  const open = [...openByInstrument.values()].flat().filter((l) => l.quantity.scaled > 0n)
  return { open, disposals }
}

export const costBasisAt = (txns: readonly Txn[], on: IsoDate): Map<number, Money> => {
  const { open } = buildLots(txns.filter((t) => t.tradeDate <= on))
  const totals = new Map<number, Money>()
  for (const lot of open) {
    totals.set(lot.instrumentId, addMoney(totals.get(lot.instrumentId) ?? zeroMoney('EUR'), lot.costEur))
  }
  return totals
}
```

Note: `proportionalCost` above is unused — delete it before committing. It is listed only so
you recognise it if an earlier draft left it behind.

- [ ] **Step 4: Run the tests**

Run: `bun test src/core/costbasis.test.ts` → all PASS. If the split test fails on rounding, the
scaling in the `SPLIT` branch is the place to look: lots are rescaled proportionally to the new
total, and the last lot absorbs any remainder.

Then `bun run check`.

- [ ] **Step 5: Commit**

```bash
git add src/core/costbasis.ts src/core/costbasis.test.ts
git commit -m "feat: fifo cost basis with fees, splits and eur conversion"
```

---

### Task 5: `core/returns` — value series, XIRR and TWR

**Files:**
- Create: `src/core/returns.ts`
- Test: `src/core/returns.test.ts`

**Interfaces:**
- Consumes: `core/money`, `core/types`, `core/ledger`
- Produces:
  - `type PriceLookup = { priceOn(instrumentId: number, date: IsoDate): Money | null; priceDateOn(instrumentId: number, date: IsoDate): IsoDate | null; fxOn(currency: Currency, date: IsoDate): FxRate | null }` — Step 4 explains why `priceDateOn` exists; write it into the type from the start
  - `valueSeries(txns: Txn[], instruments: Instrument[], prices: PriceLookup, from: IsoDate, to: IsoDate): ValuePoint[]`
  - `type ValuePoint = { date: IsoDate; valueEur: Money; stale: boolean }`
  - `xirr(flows: CashFlow[], finalValue: CashFlow): number`
  - `twr(values: ValuePoint[], flows: CashFlow[]): number`
  - `datesBetween(from: IsoDate, to: IsoDate): IsoDate[]`

Both `xirr` and `twr` return annualised decimal rates (`0.0734` = 7.34%). They are the only
`number` values in `core` — ratios, not amounts.

`priceOn` and `fxOn` return the last known value on or before the date, or `null` if none exists
yet. A day valued from a price older than itself is marked `stale: true` so the UI can badge it.

- [ ] **Step 1: Write the failing tests**

`src/core/returns.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { valueSeries, xirr, twr, datesBetween } from './returns'
import type { PriceLookup } from './returns'
import type { Instrument, Txn, TransactionType, CashFlow } from './types'
import { parseMoney, parseQuantity, parseFxRate, formatMoney } from './money'

const instrument: Instrument = {
  id: 7, isin: 'FI0009000681', ticker: 'NOKIA.HE', name: 'Nokia',
  kind: 'stock', currency: 'EUR', priceSource: 'yahoo', sourceKey: 'NOKIA.HE',
}

let nextId = 1
const txn = (type: TransactionType, tradeDate: string, o: { qty?: string; amount?: string } = {}): Txn => ({
  id: nextId++, accountId: 1, instrumentId: o.qty ? 7 : null, type, tradeDate,
  quantity: parseQuantity(o.qty ?? '0'), unitPrice: null,
  amount: parseMoney(o.amount ?? '0', 'EUR'),
  fee: parseMoney('0', 'EUR'), tax: parseMoney('0', 'EUR'),
  currency: 'EUR', fxRateEur: parseFxRate('1', 'EUR'),
})

const lookup = (byDate: Record<string, string>): PriceLookup => ({
  priceOn: (_id, date) => {
    const known = Object.keys(byDate).filter((d) => d <= date).sort().at(-1)
    return known ? parseMoney(byDate[known]!, 'EUR') : null
  },
  fxOn: () => parseFxRate('1', 'EUR'),
})

test('enumerates every calendar day inclusive', () => {
  expect(datesBetween('2025-01-30', '2025-02-02'))
    .toEqual(['2025-01-30', '2025-01-31', '2025-02-01', '2025-02-02'])
})

test('values a position each day at its latest known price', () => {
  const txns = [txn('BUY', '2025-01-01', { qty: '10', amount: '-1000,00' })]
  const series = valueSeries(txns, [instrument], lookup({ '2025-01-01': '100,00', '2025-01-03': '110,00' }), '2025-01-01', '2025-01-04')
  expect(series.map((p) => formatMoney(p.valueEur)))
    .toEqual(['1000.00', '1000.00', '1100.00', '1100.00'])
})

test('marks days valued from an older price as stale', () => {
  const txns = [txn('BUY', '2025-01-01', { qty: '10', amount: '-1000,00' })]
  const series = valueSeries(txns, [instrument], lookup({ '2025-01-01': '100,00' }), '2025-01-01', '2025-01-03')
  expect(series.map((p) => p.stale)).toEqual([false, true, true])
})

test('values are zero before the first purchase', () => {
  const txns = [txn('BUY', '2025-01-03', { qty: '10', amount: '-1000,00' })]
  const series = valueSeries(txns, [instrument], lookup({ '2025-01-01': '100,00' }), '2025-01-01', '2025-01-03')
  expect(series.map((p) => formatMoney(p.valueEur))).toEqual(['0.00', '0.00', '1000.00'])
})

test('xirr recovers a known 10% annual return', () => {
  const flows: CashFlow[] = [{ date: '2024-01-01', amountEur: parseMoney('-1000,00', 'EUR') }]
  const final: CashFlow = { date: '2025-01-01', amountEur: parseMoney('1100,00', 'EUR') }
  expect(xirr(flows, final)).toBeCloseTo(0.1, 4)
})

test('xirr handles multiple irregular contributions', () => {
  const flows: CashFlow[] = [
    { date: '2024-01-01', amountEur: parseMoney('-1000,00', 'EUR') },
    { date: '2024-07-01', amountEur: parseMoney('-500,00', 'EUR') },
  ]
  const final: CashFlow = { date: '2025-01-01', amountEur: parseMoney('1650,00', 'EUR') }
  const rate = xirr(flows, final)
  expect(rate).toBeGreaterThan(0.09)
  expect(rate).toBeLessThan(0.13)
})

test('xirr converges on a loss', () => {
  const flows: CashFlow[] = [{ date: '2024-01-01', amountEur: parseMoney('-1000,00', 'EUR') }]
  const final: CashFlow = { date: '2025-01-01', amountEur: parseMoney('800,00', 'EUR') }
  expect(xirr(flows, final)).toBeCloseTo(-0.2, 4)
})

test('xirr throws rather than returning a bogus rate when all flows share a sign', () => {
  const flows: CashFlow[] = [{ date: '2024-01-01', amountEur: parseMoney('-1000,00', 'EUR') }]
  const final: CashFlow = { date: '2025-01-01', amountEur: parseMoney('-50,00', 'EUR') }
  expect(() => xirr(flows, final)).toThrow(/sign/i)
})

test('twr ignores the timing of deposits', () => {
  // Portfolio doubles, but a deposit lands halfway. TWR must stay ~100%, not be diluted.
  const values = [
    { date: '2024-01-01', valueEur: parseMoney('1000,00', 'EUR'), stale: false },
    { date: '2024-07-01', valueEur: parseMoney('1400,00', 'EUR'), stale: false },
    { date: '2024-12-31', valueEur: parseMoney('3360,00', 'EUR'), stale: false },
  ]
  const flows: CashFlow[] = [{ date: '2024-07-01', amountEur: parseMoney('1000,00', 'EUR') }]
  expect(twr(values, flows)).toBeCloseTo(0.96, 2)
})

test('twr of a flat portfolio is zero', () => {
  const values = [
    { date: '2024-01-01', valueEur: parseMoney('1000,00', 'EUR'), stale: false },
    { date: '2024-12-31', valueEur: parseMoney('1000,00', 'EUR'), stale: false },
  ]
  expect(twr(values, [])).toBeCloseTo(0, 6)
})
```

- [ ] **Step 2: Run and watch them fail**

Run: `bun test src/core/returns.test.ts`
Expected: FAIL — `Cannot find module './returns'`.

- [ ] **Step 3: Implement**

`src/core/returns.ts`:

```ts
import { addMoney, mulMoney, toEur, zeroMoney, type Currency, type FxRate, type Money } from './money'
import { positionsAt } from './ledger'
import type { CashFlow, Instrument, IsoDate, Txn } from './types'

export type ValuePoint = { readonly date: IsoDate; readonly valueEur: Money; readonly stale: boolean }

export type PriceLookup = {
  priceOn(instrumentId: number, date: IsoDate): Money | null
  fxOn(currency: Currency, date: IsoDate): FxRate | null
}

const DAY_MS = 86_400_000

export const datesBetween = (from: IsoDate, to: IsoDate): IsoDate[] => {
  const out: IsoDate[] = []
  for (let t = Date.parse(from); t <= Date.parse(to); t += DAY_MS) {
    out.push(new Date(t).toISOString().slice(0, 10))
  }
  return out
}

const yearsBetween = (a: IsoDate, b: IsoDate): number =>
  (Date.parse(b) - Date.parse(a)) / (365.25 * DAY_MS)

/**
 * Daily EUR value of all positions. A day is `stale` when any held instrument's
 * newest price predates that day.
 */
export const valueSeries = (
  txns: readonly Txn[],
  instruments: readonly Instrument[],
  prices: PriceLookup,
  from: IsoDate,
  to: IsoDate,
): ValuePoint[] => {
  const byId = new Map(instruments.map((i) => [i.id, i]))
  return datesBetween(from, to).map((date) => {
    let value = zeroMoney('EUR')
    let stale = false
    for (const [instrumentId, qty] of positionsAt(txns, date)) {
      const instrument = byId.get(instrumentId)
      if (!instrument) continue
      const price = prices.priceOn(instrumentId, date)
      if (price === null) { stale = true; continue }
      if (prices.priceOn(instrumentId, date) !== null && !hasPriceExactlyOn(prices, instrumentId, date)) stale = true
      const native = mulMoney(price, qty)
      if (instrument.currency === 'EUR') { value = addMoney(value, native); continue }
      const rate = prices.fxOn(instrument.currency, date)
      if (rate === null) { stale = true; continue }
      value = addMoney(value, toEur(native, rate))
    }
    return { date, valueEur: value, stale }
  })
}

/** True when a price exists dated exactly `date` (not carried forward). */
const hasPriceExactlyOn = (prices: PriceLookup, instrumentId: number, date: IsoDate): boolean => {
  const today = prices.priceOn(instrumentId, date)
  const yesterday = prices.priceOn(instrumentId, new Date(Date.parse(date) - DAY_MS).toISOString().slice(0, 10))
  if (today === null) return false
  if (yesterday === null) return true
  return today.minor !== yesterday.minor ? true : prices.priceOn(instrumentId, date) !== null && false
}

const toNumber = (m: Money): number => Number(m.minor) / 100

/** Money-weighted return. `flows` are contributions (negative) and withdrawals (positive). */
export const xirr = (flows: readonly CashFlow[], finalValue: CashFlow): number => {
  const all = [...flows, finalValue]
  if (all.length < 2) throw new Error('xirr needs at least two cash flows')
  const amounts = all.map((f) => toNumber(f.amountEur))
  if (!(amounts.some((a) => a > 0) && amounts.some((a) => a < 0))) {
    throw new Error('xirr requires cash flows of both signs')
  }
  const t0 = all[0]!.date
  const years = all.map((f) => yearsBetween(t0, f.date))

  const npv = (rate: number): number =>
    amounts.reduce((sum, a, i) => sum + a / Math.pow(1 + rate, years[i]!), 0)

  // Newton-Raphson, with bisection as the fallback when it wanders.
  let rate = 0.1
  for (let i = 0; i < 60; i++) {
    const f = npv(rate)
    if (Math.abs(f) < 1e-9) return rate
    const derivative = amounts.reduce(
      (sum, a, i2) => sum - (years[i2]! * a) / Math.pow(1 + rate, years[i2]! + 1), 0)
    if (derivative === 0) break
    const next = rate - f / derivative
    if (!Number.isFinite(next) || next <= -0.999999) break
    if (Math.abs(next - rate) < 1e-12) return next
    rate = next
  }

  let low = -0.9999
  let high = 100
  if (npv(low) * npv(high) > 0) throw new Error('xirr failed to bracket a root')
  for (let i = 0; i < 400; i++) {
    const mid = (low + high) / 2
    if (npv(low) * npv(mid) <= 0) high = mid
    else low = mid
  }
  return (low + high) / 2
}

/** Time-weighted return: chain sub-period returns, neutralising external flows. */
export const twr = (values: readonly ValuePoint[], flows: readonly CashFlow[]): number => {
  if (values.length < 2) return 0
  const flowOn = new Map<IsoDate, number>()
  for (const f of flows) flowOn.set(f.date, (flowOn.get(f.date) ?? 0) + toNumber(f.amountEur))

  let chained = 1
  for (let i = 1; i < values.length; i++) {
    const start = toNumber(values[i - 1]!.valueEur)
    const end = toNumber(values[i]!.valueEur)
    const flow = flowOn.get(values[i]!.date) ?? 0
    if (start + flow === 0) continue
    chained *= (end) / (start + flow)
  }
  return chained - 1
}
```

- [ ] **Step 4: Run the tests and fix the staleness helper**

Run: `bun test src/core/returns.test.ts`

`hasPriceExactlyOn` as written above is deliberately wrong — a `PriceLookup` that only exposes
"last price on or before" cannot tell a fresh price from a carried-forward one. Replace it by
widening the interface: add `priceDateOn(instrumentId, date): IsoDate | null` returning the date
the returned price is actually dated, and set `stale = priceDateOn(...) !== date`. Update the
`PriceLookup` type, the test's `lookup` helper, and delete `hasPriceExactlyOn`.

This is the one place in the plan where you must change an interface rather than follow it: the
tests define the required behaviour, and this is what makes them pass honestly.

Then `bun run check`.

- [ ] **Step 5: Commit**

```bash
git add src/core/returns.ts src/core/returns.test.ts
git commit -m "feat: daily value series, xirr and time-weighted return"
```

---

### Task 6: `core/allocation` — grouping by dimension

**Files:**
- Create: `src/core/allocation.ts`
- Test: `src/core/allocation.test.ts`

**Interfaces:**
- Consumes: `core/money`, `core/types`, `core/ledger`, `core/returns` (`PriceLookup`)
- Produces:
  - `type Dimension = 'kind' | 'currency' | 'account' | 'instrument'`
  - `type Slice = { key: string; label: string; valueEur: Money; weight: number }`
  - `allocateBy(txns: Txn[], instruments: Instrument[], prices: PriceLookup, on: IsoDate, dimension: Dimension): Slice[]`

`weight` is a fraction of total value, `0`–`1`. Slices sort by value descending. An empty
portfolio returns `[]`, not a zero slice.

- [ ] **Step 1: Write the failing tests**

`src/core/allocation.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { allocateBy } from './allocation'
import type { PriceLookup } from './returns'
import type { Instrument, Txn } from './types'
import { parseMoney, parseQuantity, parseFxRate, formatMoney } from './money'

const instruments: Instrument[] = [
  { id: 1, isin: 'FI0009000681', ticker: 'NOKIA.HE', name: 'Nokia', kind: 'stock', currency: 'EUR', priceSource: 'yahoo', sourceKey: 'NOKIA.HE' },
  { id: 2, isin: 'IE00B4L5Y983', ticker: 'IWDA.AS', name: 'iShares Core MSCI World', kind: 'etf', currency: 'EUR', priceSource: 'yahoo', sourceKey: 'IWDA.AS' },
  { id: 3, isin: 'FI0008803812', ticker: null, name: 'OP-Suomi A', kind: 'fund', currency: 'EUR', priceSource: 'op_fund', sourceKey: 'op-suomi-a' },
]

const buy = (id: number, accountId: number, qty: string): Txn => ({
  id, accountId, instrumentId: id, type: 'BUY', tradeDate: '2025-01-01',
  quantity: parseQuantity(qty), unitPrice: null,
  amount: parseMoney('-1,00', 'EUR'), fee: parseMoney('0', 'EUR'), tax: parseMoney('0', 'EUR'),
  currency: 'EUR', fxRateEur: parseFxRate('1', 'EUR'),
})

const prices: PriceLookup = {
  priceOn: (id) => parseMoney(({ 1: '10,00', 2: '100,00', 3: '50,00' })[id]!, 'EUR'),
  priceDateOn: () => '2025-06-01',
  fxOn: () => parseFxRate('1', 'EUR'),
}

test('groups by instrument kind, largest first', () => {
  const slices = allocateBy([buy(1, 1, '100'), buy(2, 1, '10'), buy(3, 2, '10')], instruments, prices, '2025-06-01', 'kind')
  expect(slices.map((s) => s.key)).toEqual(['etf', 'stock', 'fund'])
  expect(slices.map((s) => formatMoney(s.valueEur))).toEqual(['1000.00', '1000.00', '500.00'])
})

test('weights sum to one', () => {
  const slices = allocateBy([buy(1, 1, '100'), buy(3, 2, '10')], instruments, prices, '2025-06-01', 'kind')
  expect(slices.reduce((s, x) => s + x.weight, 0)).toBeCloseTo(1, 9)
})

test('groups by account', () => {
  const slices = allocateBy([buy(1, 1, '100'), buy(3, 2, '10')], instruments, prices, '2025-06-01', 'account')
  expect(slices.map((s) => s.key)).toEqual(['1', '2'])
})

test('an empty portfolio has no slices', () => {
  expect(allocateBy([], instruments, prices, '2025-06-01', 'kind')).toEqual([])
})
```

- [ ] **Step 2: Run and watch them fail**

Run: `bun test src/core/allocation.test.ts` → FAIL, module missing.

- [ ] **Step 3: Implement**

`src/core/allocation.ts`:

```ts
import { addMoney, mulMoney, toEur, zeroMoney, type Money } from './money'
import { positionsAt } from './ledger'
import type { PriceLookup } from './returns'
import type { Instrument, IsoDate, Txn } from './types'

export type Dimension = 'kind' | 'currency' | 'account' | 'instrument'

export type Slice = {
  readonly key: string
  readonly label: string
  readonly valueEur: Money
  readonly weight: number
}

const KIND_LABELS: Record<Instrument['kind'], string> = {
  stock: 'Osakkeet', etf: 'ETF:t', fund: 'Rahastot', cash: 'Käteinen',
}

export const allocateBy = (
  txns: readonly Txn[],
  instruments: readonly Instrument[],
  prices: PriceLookup,
  on: IsoDate,
  dimension: Dimension,
): Slice[] => {
  const byId = new Map(instruments.map((i) => [i.id, i]))
  const totals = new Map<string, { label: string; value: Money }>()

  // Account grouping needs per-account positions, so walk transactions per account.
  const accountIds = [...new Set(txns.map((t) => t.accountId))]
  const buckets: Array<{ accountId: number; positions: Map<number, ReturnType<typeof positionsAt> extends Map<number, infer Q> ? Q : never> }> =
    accountIds.map((accountId) => ({
      accountId,
      positions: positionsAt(txns.filter((t) => t.accountId === accountId), on),
    }))

  for (const { accountId, positions } of buckets) {
    for (const [instrumentId, qty] of positions) {
      const instrument = byId.get(instrumentId)
      if (!instrument) continue
      const price = prices.priceOn(instrumentId, on)
      if (price === null) continue
      const native = mulMoney(price, qty)
      const rate = instrument.currency === 'EUR' ? null : prices.fxOn(instrument.currency, on)
      if (instrument.currency !== 'EUR' && rate === null) continue
      const valueEur = rate === null ? native : toEur(native, rate)

      const [key, label] =
        dimension === 'kind' ? [instrument.kind, KIND_LABELS[instrument.kind]]
        : dimension === 'currency' ? [instrument.currency, instrument.currency]
        : dimension === 'account' ? [String(accountId), `Tili ${accountId}`]
        : [String(instrument.id), instrument.name]

      const existing = totals.get(key)
      totals.set(key, {
        label,
        value: existing ? addMoney(existing.value, valueEur) : valueEur,
      })
    }
  }

  const total = [...totals.values()].reduce((sum, t) => addMoney(sum, t.value), zeroMoney('EUR'))
  if (total.minor === 0n) return []

  return [...totals.entries()]
    .map(([key, { label, value }]) => ({
      key, label, valueEur: value,
      weight: Number(value.minor) / Number(total.minor),
    }))
    .sort((a, b) => (b.valueEur.minor === a.valueEur.minor ? a.key.localeCompare(b.key) : b.valueEur.minor > a.valueEur.minor ? 1 : -1))
}
```

The `buckets` type annotation above is unnecessarily clever. Replace it with
`Array<{ accountId: number; positions: Map<number, Quantity> }>` and import `Quantity` from
`./money`.

- [ ] **Step 4: Run the tests**

Run: `bun test src/core/allocation.test.ts` → PASS. Then `bun run check`.

- [ ] **Step 5: Commit**

```bash
git add src/core/allocation.ts src/core/allocation.test.ts
git commit -m "feat: allocation slices by kind, currency, account and instrument"
```

---

### Task 7: Database — Drizzle schema on `bun:sqlite`

**Files:**
- Create: `src/server/db/schema.ts`, `src/server/db/index.ts`
- Test: `src/server/db/schema.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (the schema mirrors `core/types` but does not import it — `core` stays pure and the DB layer owns its own row types)
- Produces:
  - `openDb(path?: string): { sqlite: Database; db: BunSQLiteDatabase<typeof schema> }`
  - `migrate(db): void`
  - `testDb(): ReturnType<typeof openDb>` — an in-memory database with migrations applied, for every later test
  - Tables: `accounts`, `instruments`, `transactions`, `snapshots`, `snapshotRows`, `prices`, `fxRates`, `imports`, `priceFetchLog`, plus Better Auth's `user`, `session`, `account`, `verification` (Task 8)

Storage conventions, applied throughout:

- Money: `integer` minor units. A column storing money is always paired with a currency column or is EUR by definition.
- Quantity: `integer` scaled 10^6. FX rate: `integer` scaled 10^8.
- Dates: `text` `yyyy-mm-dd`. Timestamps: `integer` epoch milliseconds.
- SQLite is opened with `PRAGMA journal_mode = WAL` and `PRAGMA foreign_keys = ON`.

- [ ] **Step 1: Write the failing test**

`src/server/db/schema.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { eq } from 'drizzle-orm'
import { testDb } from './index'
import { accounts, instruments, transactions } from './schema'

test('applies migrations to a fresh in-memory database', () => {
  const { db } = testDb()
  expect(db.select().from(accounts).all()).toEqual([])
})

test('stores money as integer minor units and quantity scaled by 1e6', () => {
  const { db } = testDb()
  const [user] = db.insert(accounts).values({
    userId: 'u1', name: 'Nordnet AOT', broker: 'nordnet', baseCurrency: 'EUR',
  }).returning().all()
  const [nokia] = db.insert(instruments).values({
    isin: 'FI0009000681', ticker: 'NOKIA.HE', name: 'Nokia', kind: 'stock',
    currency: 'EUR', priceSource: 'yahoo', sourceKey: 'NOKIA.HE',
  }).returning().all()

  db.insert(transactions).values({
    accountId: user!.id, instrumentId: nokia!.id, type: 'BUY', tradeDate: '2025-01-10',
    quantity: 10_000_000, unitPrice: 10_00, amount: -100_00, fee: 3_00, tax: 0,
    currency: 'EUR', fxRateEur: 100_000_000, contentHash: 'abc', externalId: null, importId: null,
  }).run()

  const [row] = db.select().from(transactions).where(eq(transactions.accountId, user!.id)).all()
  expect(row!.quantity).toBe(10_000_000)
  expect(row!.amount).toBe(-10000)
  expect(row!.fxRateEur).toBe(100_000_000)
})

test('rejects a duplicate content hash within one account', () => {
  const { db } = testDb()
  const [acct] = db.insert(accounts).values({
    userId: 'u1', name: 'OP', broker: 'op', baseCurrency: 'EUR',
  }).returning().all()
  const row = {
    accountId: acct!.id, instrumentId: null, type: 'DEPOSIT' as const, tradeDate: '2025-01-01',
    quantity: 0, unitPrice: null, amount: 500_00, fee: 0, tax: 0,
    currency: 'EUR' as const, fxRateEur: 100_000_000,
    contentHash: 'dup', externalId: null, importId: null,
  }
  db.insert(transactions).values(row).run()
  expect(() => db.insert(transactions).values(row).run()).toThrow(/UNIQUE/i)
})

test('enforces foreign keys', () => {
  const { db } = testDb()
  expect(() => db.insert(transactions).values({
    accountId: 999, instrumentId: null, type: 'DEPOSIT', tradeDate: '2025-01-01',
    quantity: 0, unitPrice: null, amount: 1, fee: 0, tax: 0,
    currency: 'EUR', fxRateEur: 100_000_000, contentHash: 'x', externalId: null, importId: null,
  }).run()).toThrow(/FOREIGN KEY/i)
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `bun test src/server/db/schema.test.ts` → FAIL, modules missing.

- [ ] **Step 3: Write the schema**

`src/server/db/schema.ts`:

```ts
import { sql } from 'drizzle-orm'
import { index, integer, primaryKey, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core'

// --- Better Auth tables (Task 8 generates the migration; shape fixed by the adapter) ---

export const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  image: text('image'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
})

export const session = sqliteTable('session', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
})

export const account = sqliteTable('account', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  password: text('password'),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp_ms' }),
  refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp_ms' }),
  scope: text('scope'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
})

export const verification = sqliteTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
})

// --- Application tables ---

export const accounts = sqliteTable('accounts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  broker: text('broker', { enum: ['nordnet', 'op', 'spankki', 'danske', 'other'] }).notNull(),
  baseCurrency: text('base_currency', { enum: ['EUR', 'USD'] }).notNull().default('EUR'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(sql`(unixepoch() * 1000)`),
}, (t) => [index('accounts_user_idx').on(t.userId)])

export const instruments = sqliteTable('instruments', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  isin: text('isin').notNull().unique(),
  ticker: text('ticker'),
  name: text('name').notNull(),
  kind: text('kind', { enum: ['stock', 'etf', 'fund', 'cash'] }).notNull(),
  currency: text('currency', { enum: ['EUR', 'USD'] }).notNull(),
  priceSource: text('price_source', {
    enum: ['yahoo', 'nordnet_fund', 'op_fund', 'spankki_fund', 'danske_fund', 'manual'],
  }).notNull(),
  sourceKey: text('source_key').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(sql`(unixepoch() * 1000)`),
})

export const imports = sqliteTable('imports', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  kind: text('kind', { enum: ['csv_nordnet', 'csv_op', 'pdf', 'vision', 'manual'] }).notNull(),
  filename: text('filename').notNull(),
  sha256: text('sha256').notNull(),
  status: text('status', { enum: ['draft', 'committed', 'undone'] }).notNull().default('draft'),
  rowCount: integer('row_count').notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(sql`(unixepoch() * 1000)`),
})

export const transactions = sqliteTable('transactions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  accountId: integer('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  instrumentId: integer('instrument_id').references(() => instruments.id),
  type: text('type', {
    enum: ['BUY', 'SELL', 'DIVIDEND', 'FEE', 'INTEREST',
           'DEPOSIT', 'WITHDRAWAL', 'SPLIT', 'TRANSFER_IN', 'TRANSFER_OUT'],
  }).notNull(),
  tradeDate: text('trade_date').notNull(),
  quantity: integer('quantity').notNull().default(0),          // scaled 1e6
  unitPrice: integer('unit_price'),                            // minor units
  amount: integer('amount').notNull().default(0),              // minor units, signed
  fee: integer('fee').notNull().default(0),
  tax: integer('tax').notNull().default(0),
  currency: text('currency', { enum: ['EUR', 'USD'] }).notNull(),
  fxRateEur: integer('fx_rate_eur').notNull(),                 // scaled 1e8
  externalId: text('external_id'),
  contentHash: text('content_hash').notNull(),
  importId: integer('import_id').references(() => imports.id),
  note: text('note'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(sql`(unixepoch() * 1000)`),
}, (t) => [
  unique('txn_external_uq').on(t.accountId, t.externalId),
  unique('txn_hash_uq').on(t.accountId, t.contentHash),
  index('txn_account_date_idx').on(t.accountId, t.tradeDate),
  index('txn_import_idx').on(t.importId),
])

export const snapshots = sqliteTable('snapshots', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  accountId: integer('account_id').notNull().references(() => accounts.id, { onDelete: 'cascade' }),
  asOf: text('as_of').notNull(),
  source: text('source', { enum: ['pdf', 'vision', 'manual'] }).notNull(),
  importId: integer('import_id').references(() => imports.id),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(sql`(unixepoch() * 1000)`),
})

export const snapshotRows = sqliteTable('snapshot_rows', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  snapshotId: integer('snapshot_id').notNull().references(() => snapshots.id, { onDelete: 'cascade' }),
  instrumentId: integer('instrument_id').notNull().references(() => instruments.id),
  quantity: integer('quantity').notNull(),
  nav: integer('nav').notNull(),
  marketValue: integer('market_value').notNull(),
})

export const prices = sqliteTable('prices', {
  instrumentId: integer('instrument_id').notNull().references(() => instruments.id, { onDelete: 'cascade' }),
  date: text('date').notNull(),
  close: integer('close').notNull(),
  currency: text('currency', { enum: ['EUR', 'USD'] }).notNull(),
  source: text('source').notNull(),
  fetchedAt: integer('fetched_at', { mode: 'timestamp_ms' }).notNull(),
}, (t) => [primaryKey({ columns: [t.instrumentId, t.date] })])

export const fxRates = sqliteTable('fx_rates', {
  date: text('date').notNull(),
  currency: text('currency', { enum: ['USD'] }).notNull(),
  rateEur: integer('rate_eur').notNull(),                      // scaled 1e8
}, (t) => [primaryKey({ columns: [t.date, t.currency] })])

export const priceFetchLog = sqliteTable('price_fetch_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  source: text('source').notNull(),
  instrumentId: integer('instrument_id').references(() => instruments.id, { onDelete: 'cascade' }),
  runAt: integer('run_at', { mode: 'timestamp_ms' }).notNull(),
  ok: integer('ok', { mode: 'boolean' }).notNull(),
  message: text('message'),
}, (t) => [index('price_log_run_idx').on(t.runAt)])
```

- [ ] **Step 4: Write the connection module**

`src/server/db/index.ts`:

```ts
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate as runMigrations } from 'drizzle-orm/bun-sqlite/migrator'
import * as schema from './schema'

export const openDb = (path: string = Bun.env.DATABASE_PATH ?? './data/promptfolio.db') => {
  const sqlite = new Database(path, { create: true, strict: true })
  sqlite.exec('PRAGMA journal_mode = WAL')
  sqlite.exec('PRAGMA foreign_keys = ON')
  sqlite.exec('PRAGMA busy_timeout = 5000')
  return { sqlite, db: drizzle(sqlite, { schema }) }
}

export const migrate = (db: ReturnType<typeof openDb>['db']): void => {
  runMigrations(db, { migrationsFolder: './drizzle' })
}

/** In-memory database with migrations applied. Used by every server-side test. */
export const testDb = () => {
  const handle = openDb(':memory:')
  migrate(handle.db)
  return handle
}
```

- [ ] **Step 5: Generate the migration**

```bash
mkdir -p data
bun run db:generate
```

This writes SQL into `drizzle/`. Read the generated SQL before trusting it — confirm the two
unique constraints on `transactions` and the composite primary keys on `prices` and `fx_rates`
are present.

- [ ] **Step 6: Run the tests**

Run: `bun test src/server/db/schema.test.ts` → all PASS.

If `strict: true` on `new Database` rejects the named-parameter style Drizzle emits, drop that
option — it is a convenience, not a requirement. If the foreign-key test does not throw, the
`PRAGMA foreign_keys = ON` did not take: it must be executed on every connection, not once.

Then `bun run check`.

- [ ] **Step 7: Commit**

```bash
git add src/server/db drizzle drizzle.config.ts
git commit -m "feat: drizzle sqlite schema for ledger, prices, fx and imports"
```

---

### Task 8: Auth — Better Auth on Drizzle with `Bun.password`

**Files:**
- Create: `src/server/auth.ts`, `src/server/auth-guard.ts`, `src/server/password.ts`
- Test: `src/server/auth.test.ts`

**Interfaces:**
- Consumes: `src/server/db` (Task 7)
- Produces:
  - `auth` — the Better Auth instance; `auth.handler(req: Request): Promise<Response>`
  - `requireUser(req: Request): Promise<{ userId: string }>` — throws `HttpError(401)` when unauthenticated
  - `class HttpError extends Error { status: number }`
  - `hashPassword(password: string): Promise<string>`, `verifyPassword(d: { password: string; hash: string }): Promise<boolean>`

Better Auth owns sessions, cookies, CSRF and the `user`/`session`/`account`/`verification`
tables. Do not hand-roll any of it. The only thing swapped out is the hashing backend, which
becomes `Bun.password` so no native argon2 dependency is needed.

Sign-up is closed by default: this is a family instance, not a public service. `signUp` is
allowed only when `Bun.env.ALLOW_SIGNUP === 'true'`, which you set once to create each account
and then unset.

- [ ] **Step 1: Write the failing tests**

`src/server/auth.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { hashPassword, verifyPassword } from './password'
import { HttpError, requireUser } from './auth-guard'

test('hashes with argon2id and verifies', async () => {
  const hash = await hashPassword('correct horse battery staple')
  expect(hash).toStartWith('$argon2id$')
  expect(await verifyPassword({ password: 'correct horse battery staple', hash })).toBe(true)
  expect(await verifyPassword({ password: 'wrong', hash })).toBe(false)
})

test('the same password hashes differently each time', async () => {
  const a = await hashPassword('same')
  const b = await hashPassword('same')
  expect(a).not.toBe(b)
})

test('requireUser rejects a request with no session cookie', async () => {
  const request = new Request('http://localhost/api/holdings')
  await expect(requireUser(request)).rejects.toThrow(HttpError)
  await expect(requireUser(request)).rejects.toMatchObject({ status: 401 })
})
```

- [ ] **Step 2: Run and watch them fail**

Run: `bun test src/server/auth.test.ts` → FAIL, modules missing.

- [ ] **Step 3: Implement password hashing on Bun**

`src/server/password.ts`:

```ts
const OPTIONS = { algorithm: 'argon2id', memoryCost: 65536, timeCost: 3 } as const

export const hashPassword = (password: string): Promise<string> =>
  Bun.password.hash(password, OPTIONS)

export const verifyPassword = (data: { password: string; hash: string }): Promise<boolean> =>
  Bun.password.verify(data.password, data.hash)
```

- [ ] **Step 4: Implement the auth instance**

`src/server/auth.ts`:

```ts
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from '@better-auth/drizzle-adapter'
import { openDb } from './db'
import { hashPassword, verifyPassword } from './password'

const { db } = openDb()

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: 'sqlite' }),
  baseURL: Bun.env.BASE_URL ?? 'http://localhost:3000',
  secret: (() => {
    const secret = Bun.env.BETTER_AUTH_SECRET
    if (!secret || secret.length < 32) {
      throw new Error('BETTER_AUTH_SECRET must be set to at least 32 characters')
    }
    return secret
  })(),
  emailAndPassword: {
    enabled: true,
    disableSignUp: Bun.env.ALLOW_SIGNUP !== 'true',
    password: { hash: hashPassword, verify: verifyPassword },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
  },
})
```

Refusing to boot without a real `BETTER_AUTH_SECRET` is deliberate — a default secret in a
self-hosted financial app is a silent authentication bypass. Generate one with
`bun -e 'console.log(crypto.randomUUID() + crypto.randomUUID())'`.

- [ ] **Step 5: Implement the request guard**

`src/server/auth-guard.ts`:

```ts
import { auth } from './auth'

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'HttpError'
  }
}

export const requireUser = async (request: Request): Promise<{ userId: string }> => {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user?.id) throw new HttpError(401, 'Kirjautuminen vaaditaan')
  return { userId: session.user.id }
}
```

Every route handler in Tasks 9, 12, 13 and 16 calls `requireUser` first and scopes its queries by
the returned `userId`. A route that takes an account id from the client must still confirm that
account belongs to `userId` — ownership is never inferred from the request alone.

- [ ] **Step 6: Run the tests**

Set a secret for the test run:

```bash
BETTER_AUTH_SECRET=$(bun -e 'console.log(crypto.randomUUID()+crypto.randomUUID())') bun test src/server/auth.test.ts
```

Expected: PASS. Add that variable to `.env` (gitignored) and to `.env.example` (committed, with a
placeholder value).

If Better Auth's generated table shapes drift from `schema.ts`, regenerate rather than hand-edit:

```bash
bunx @better-auth/cli generate --output src/server/db/auth-schema.ts
```

Then reconcile any differences into `schema.ts` and re-run `bun run db:generate`. Better Auth's
adapter is the authority on those four tables' shape.

- [ ] **Step 7: Commit**

```bash
git add src/server/auth.ts src/server/auth-guard.ts src/server/password.ts src/server/auth.test.ts .env.example
git commit -m "feat: better auth on drizzle with bun argon2id hashing and closed signup"
```

---

### Task 9: HTTP server and the accounts / instruments API

**Files:**
- Create: `src/server/http.ts`, `src/server/api/accounts.ts`, `src/server/api/instruments.ts`, `src/server/index.ts`
- Test: `src/server/api/accounts.test.ts`

**Interfaces:**
- Consumes: `src/server/db` (Task 7), `requireUser` / `HttpError` (Task 8)
- Produces:
  - `json(data: unknown, status?: number): Response`
  - `handle(fn: (req: Request) => Promise<Response>): (req: Request) => Promise<Response>` — maps `HttpError` and `ZodError` to responses
  - `accountRoutes` / `instrumentRoutes` — plain objects of `Bun.serve` route handlers
  - `assertAccountOwned(userId: string, accountId: number): void`

`Bun.serve`'s `routes` option owns routing — no Express, no Hono. Route values are either a
handler function or an object keyed by HTTP method.

- [ ] **Step 1: Write the failing test**

`src/server/api/accounts.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { z } from 'zod'
import { handle, json, HttpError } from '../http'

test('wraps a handler result as JSON', async () => {
  const response = await handle(async () => json({ ok: true }))(new Request('http://x/'))
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toContain('application/json')
  expect(await response.json()).toEqual({ ok: true })
})

test('maps HttpError to its status and a Finnish message', async () => {
  const response = await handle(async () => { throw new HttpError(403, 'Ei oikeuksia') })(new Request('http://x/'))
  expect(response.status).toBe(403)
  expect(await response.json()).toEqual({ error: 'Ei oikeuksia' })
})

test('maps a Zod failure to 400 with field detail', async () => {
  const schema = z.object({ name: z.string().min(1) })
  const response = await handle(async () => { schema.parse({ name: '' }); return json({}) })(new Request('http://x/'))
  expect(response.status).toBe(400)
  const body = await response.json() as { error: string; fields: Array<{ path: string }> }
  expect(body.fields[0]!.path).toBe('name')
})

test('never leaks an unexpected error message to the client', async () => {
  const response = await handle(async () => { throw new Error('SELECT * FROM secrets failed') })(new Request('http://x/'))
  expect(response.status).toBe(500)
  expect(await response.text()).not.toContain('secrets')
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `bun test src/server/api/accounts.test.ts` → FAIL, `../http` missing.

- [ ] **Step 3: Implement the HTTP helpers**

`src/server/http.ts`:

```ts
import { ZodError } from 'zod'
import { HttpError } from './auth-guard'

export { HttpError }

export const json = (data: unknown, status = 200): Response =>
  Response.json(data, { status })

export const handle =
  (fn: (request: Request) => Promise<Response>) =>
  async (request: Request): Promise<Response> => {
    try {
      return await fn(request)
    } catch (cause) {
      if (cause instanceof HttpError) return json({ error: cause.message }, cause.status)
      if (cause instanceof ZodError) {
        return json({
          error: 'Virheellinen pyyntö',
          fields: cause.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        }, 400)
      }
      console.error('Unhandled request error', cause)
      return json({ error: 'Palvelinvirhe' }, 500)
    }
  }
```

The last branch is why the fourth test exists: internal detail goes to the server log, never to
the client.

- [ ] **Step 4: Implement the account routes**

`src/server/api/accounts.ts`:

```ts
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { openDb } from '../db'
import { accounts } from '../db/schema'
import { requireUser } from '../auth-guard'
import { HttpError, handle, json } from '../http'

const { db } = openDb()

const CreateAccount = z.object({
  name: z.string().min(1).max(100),
  broker: z.enum(['nordnet', 'op', 'spankki', 'danske', 'other']),
  baseCurrency: z.enum(['EUR', 'USD']).default('EUR'),
})

export const assertAccountOwned = (userId: string, accountId: number): void => {
  const owned = db.select({ id: accounts.id }).from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.userId, userId))).get()
  if (!owned) throw new HttpError(404, 'Tiliä ei löydy')
}

export const accountRoutes = {
  '/api/accounts': {
    GET: handle(async (request) => {
      const { userId } = await requireUser(request)
      return json(db.select().from(accounts).where(eq(accounts.userId, userId)).all())
    }),
    POST: handle(async (request) => {
      const { userId } = await requireUser(request)
      const body = CreateAccount.parse(await request.json())
      const created = db.insert(accounts).values({ ...body, userId }).returning().get()
      return json(created, 201)
    }),
  },
}
```

- [ ] **Step 5: Implement the instrument routes**

`src/server/api/instruments.ts`:

```ts
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { openDb } from '../db'
import { instruments } from '../db/schema'
import { requireUser } from '../auth-guard'
import { HttpError, handle, json } from '../http'

const { db } = openDb()

const UpsertInstrument = z.object({
  isin: z.string().regex(/^[A-Z]{2}[A-Z0-9]{9}\d$/, 'ISIN-tunnus on virheellinen'),
  ticker: z.string().min(1).max(20).nullable(),
  name: z.string().min(1).max(200),
  kind: z.enum(['stock', 'etf', 'fund', 'cash']),
  currency: z.enum(['EUR', 'USD']),
  priceSource: z.enum(['yahoo', 'nordnet_fund', 'op_fund', 'spankki_fund', 'danske_fund', 'manual']),
  sourceKey: z.string().min(1).max(200),
})

export const instrumentRoutes = {
  '/api/instruments': {
    GET: handle(async (request) => {
      await requireUser(request)
      return json(db.select().from(instruments).all())
    }),
    POST: handle(async (request) => {
      await requireUser(request)
      const body = UpsertInstrument.parse(await request.json())
      const existing = db.select().from(instruments).where(eq(instruments.isin, body.isin)).get()
      if (existing) throw new HttpError(409, `ISIN ${body.isin} on jo lisätty`)
      return json(db.insert(instruments).values(body).returning().get(), 201)
    }),
  },
}
```

Instruments are shared reference data across the family instance, so they are readable by any
authenticated user; only ledger rows are scoped per user.

Accounts get list and create only. Rename and delete are deliberately absent from Phase 1:
deleting an account cascades to its transactions, which is a destructive operation that deserves
its own confirmation flow rather than a route added for symmetry. Add them when you actually need
them.

- [ ] **Step 6: Implement the entrypoint**

`src/server/index.ts`:

```ts
import index from '../web/index.html'
import { auth } from './auth'
import { accountRoutes } from './api/accounts'
import { instrumentRoutes } from './api/instruments'

const server = Bun.serve({
  port: Number(Bun.env.PORT ?? 3000),
  development: Bun.env.NODE_ENV !== 'production',
  routes: {
    '/api/auth/*': (request) => auth.handler(request),
    ...accountRoutes,
    ...instrumentRoutes,
    '/*': index,
  },
})

console.log(`PromptFolio kuuntelee osoitteessa ${server.url}`)
```

The HTML import is what removes the bundler: `Bun.serve` compiles `src/web/index.html` and its
`<script>` graph on demand in development and serves the prebuilt output in production.

- [ ] **Step 7: Run the tests, then the server**

Run: `bun test src/server` → PASS. Then `bun run dev` and check `curl -i localhost:3000/api/accounts`
returns `401` with `{"error":"Kirjautuminen vaaditaan"}`. Task 17 creates `src/web/index.html`;
until then the `/*` route will fail to resolve — comment out the import and that route line, and
restore both in Task 17.

Then `bun run check`.

- [ ] **Step 8: Commit**

```bash
git add src/server/http.ts src/server/api src/server/index.ts
git commit -m "feat: bun.serve routing with accounts and instruments api"
```

---

### Task 10: CSV parsing driven by per-broker configuration

**Files:**
- Create: `src/server/import/types.ts`, `src/server/import/csv.ts`, `src/server/import/brokers.ts`
- Test: `src/server/import/csv.test.ts`
- Test fixtures: `src/server/import/fixtures/nordnet-sample.csv`, `src/server/import/fixtures/op-sample.csv`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `type RawRow = { line: number; values: Record<string, string> }`
  - `type BrokerCsvConfig` (below)
  - `parseCsv(bytes: ArrayBuffer, config: BrokerCsvConfig): { rows: RawRow[]; headers: string[] }`
  - `NORDNET: BrokerCsvConfig`, `OP: BrokerCsvConfig`
  - `detectBroker(headers: string[]): BrokerCsvConfig | null`

This task produces **strings only**. No domain types, no money parsing, no validation — that is
Task 11. Keeping the parser dumb is what lets a broker changing its export be a config edit.

- [ ] **Step 1: Create the fixtures**

`src/server/import/fixtures/nordnet-sample.csv` — semicolon-delimited, Finnish headers, decimal
comma. Write it exactly:

```
Id;Kirjauspäivä;Kauppapäivä;Maksupäivä;Tapahtumatyyppi;Arvopaperi;ISIN;Määrä;Kurssi;Kokonaiskulut;Valuutta;Summa
1001;2025-01-10;2025-01-10;2025-01-14;OSTO;NOKIA;FI0009000681;100;4,15;3,00;EUR;-418,00
1002;2025-02-03;2025-02-03;2025-02-05;TALLETUS;;;0;0;0;EUR;5000,00
1003;2025-03-20;2025-03-20;2025-03-24;OSINKO;NOKIA;FI0009000681;100;0,13;0;EUR;13,00
1004;2025-04-01;2025-04-01;2025-04-03;MYYNTI;NOKIA;FI0009000681;40;4,60;3,00;EUR;181,00
1005;2025-05-02;2025-05-02;2025-05-06;OSTO;ISHARES CORE MSCI WORLD;IE00B4L5Y983;10;98,42;1,50;USD;-985,70
```

`src/server/import/fixtures/op-sample.csv` — different headers and `dd.mm.yyyy` dates:

```
Päivämäärä;Laji;Kohde;ISIN;Osuudet;Hinta;Kulut;Valuutta;Yhteensä
15.01.2025;Merkintä;OP-Suomi A;FI0008803812;12,3456;15,25;0,00;EUR;-188,27
01.02.2025;Talletus;;;0;0;0,00;EUR;1000,00
03.06.2025;Lunastus;OP-Suomi A;FI0008803812;5,0000;16,10;0,00;EUR;80,50
```

- [ ] **Step 2: Write the failing tests**

`src/server/import/csv.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { parseCsv, detectBroker } from './csv'
import { NORDNET, OP } from './brokers'

const fixture = (name: string) => Bun.file(`${import.meta.dir}/fixtures/${name}`).arrayBuffer()

test('parses the Nordnet fixture into labelled rows', async () => {
  const { rows, headers } = parseCsv(await fixture('nordnet-sample.csv'), NORDNET)
  expect(headers).toContain('Tapahtumatyyppi')
  expect(rows).toHaveLength(5)
  expect(rows[0]!.values['ISIN']).toBe('FI0009000681')
  expect(rows[0]!.values['Summa']).toBe('-418,00')
  expect(rows[0]!.line).toBe(2)
})

test('parses the OP fixture with its own delimiter and headers', async () => {
  const { rows } = parseCsv(await fixture('op-sample.csv'), OP)
  expect(rows).toHaveLength(3)
  expect(rows[0]!.values['Laji']).toBe('Merkintä')
  expect(rows[0]!.values['Osuudet']).toBe('12,3456')
})

test('detects the broker from the header row', async () => {
  const nordnet = parseCsv(await fixture('nordnet-sample.csv'), NORDNET)
  const op = parseCsv(await fixture('op-sample.csv'), OP)
  expect(detectBroker(nordnet.headers)?.broker).toBe('nordnet')
  expect(detectBroker(op.headers)?.broker).toBe('op')
  expect(detectBroker(['Date', 'Amount'])).toBeNull()
})

test('handles quoted fields containing the delimiter', () => {
  const csv = 'A;B\n"Yhtiö; Oyj";5\n'
  const { rows } = parseCsv(new TextEncoder().encode(csv).buffer, NORDNET)
  expect(rows[0]!.values['A']).toBe('Yhtiö; Oyj')
  expect(rows[0]!.values['B']).toBe('5')
})

test('skips blank trailing lines instead of emitting empty rows', () => {
  const csv = 'A;B\n1;2\n\n\n'
  const { rows } = parseCsv(new TextEncoder().encode(csv).buffer, NORDNET)
  expect(rows).toHaveLength(1)
})

test('rejects a row with the wrong number of columns rather than shifting values', () => {
  const csv = 'A;B;C\n1;2\n'
  expect(() => parseCsv(new TextEncoder().encode(csv).buffer, NORDNET)).toThrow(/rivi 2/i)
})
```

- [ ] **Step 3: Run and watch them fail**

Run: `bun test src/server/import/csv.test.ts` → FAIL, modules missing.

- [ ] **Step 4: Implement the types and parser**

`src/server/import/types.ts`:

```ts
export type RawRow = { readonly line: number; readonly values: Record<string, string> }

export type CanonicalField =
  | 'externalId' | 'tradeDate' | 'type' | 'instrumentName' | 'isin'
  | 'quantity' | 'unitPrice' | 'fee' | 'currency' | 'amount'

export type BrokerCsvConfig = {
  readonly broker: 'nordnet' | 'op'
  readonly encoding: 'utf-8' | 'latin1' | 'utf-16le'
  readonly delimiter: string
  readonly dateFormat: 'iso' | 'fi'
  /** Canonical field -> the broker's column header. Missing entries mean the broker omits it. */
  readonly columns: Partial<Record<CanonicalField, string>>
  /** The broker's transaction labels, lowercased, mapped to our types. */
  readonly typeMap: Record<string, string>
  /** Headers that identify this broker's export. */
  readonly signature: readonly string[]
}
```

`src/server/import/csv.ts`:

```ts
import type { BrokerCsvConfig, RawRow } from './types'

/** Split one CSV line, honouring double-quoted fields. */
const splitLine = (line: string, delimiter: string): string[] => {
  const out: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') { field += '"'; i++ }
      else if (char === '"') quoted = false
      else field += char
    } else if (char === '"') quoted = true
    else if (char === delimiter) { out.push(field); field = '' }
    else field += char
  }
  out.push(field)
  return out.map((f) => f.trim())
}

export const parseCsv = (
  bytes: ArrayBuffer,
  config: BrokerCsvConfig,
): { rows: RawRow[]; headers: string[] } => {
  const text = new TextDecoder(config.encoding).decode(bytes).replace(/^﻿/, '')
  const lines = text.split(/\r?\n/)
  const headerLine = lines[0]
  if (headerLine === undefined || headerLine.trim() === '') {
    throw new Error('CSV-tiedostosta puuttuu otsikkorivi')
  }
  const headers = splitLine(headerLine, config.delimiter)

  const rows: RawRow[] = []
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim() === '') continue
    const cells = splitLine(line, config.delimiter)
    if (cells.length !== headers.length) {
      throw new Error(
        `CSV rivi ${i + 1}: ${cells.length} saraketta, odotettiin ${headers.length}`,
      )
    }
    rows.push({
      line: i + 1,
      values: Object.fromEntries(headers.map((h, index) => [h, cells[index] ?? ''])),
    })
  }
  return { rows, headers }
}

export const detectBroker = (headers: readonly string[]): BrokerCsvConfig | null => {
  const present = new Set(headers)
  for (const config of BROKER_CONFIGS) {
    if (config.signature.every((h) => present.has(h))) return config
  }
  return null
}

import { BROKER_CONFIGS } from './brokers'
```

Move that trailing import to the top of the file — it is written last here only so you see why
it exists.

- [ ] **Step 5: Implement the broker configs**

`src/server/import/brokers.ts`:

```ts
import type { BrokerCsvConfig } from './types'

export const NORDNET: BrokerCsvConfig = {
  broker: 'nordnet',
  encoding: 'utf-8',
  delimiter: ';',
  dateFormat: 'iso',
  columns: {
    externalId: 'Id',
    tradeDate: 'Kauppapäivä',
    type: 'Tapahtumatyyppi',
    instrumentName: 'Arvopaperi',
    isin: 'ISIN',
    quantity: 'Määrä',
    unitPrice: 'Kurssi',
    fee: 'Kokonaiskulut',
    currency: 'Valuutta',
    amount: 'Summa',
  },
  typeMap: {
    osto: 'BUY', köp: 'BUY', buy: 'BUY',
    myynti: 'SELL', sälj: 'SELL', sell: 'SELL',
    osinko: 'DIVIDEND', utdelning: 'DIVIDEND',
    talletus: 'DEPOSIT', insättning: 'DEPOSIT',
    nosto: 'WITHDRAWAL', uttag: 'WITHDRAWAL',
    palkkio: 'FEE', 'korko': 'INTEREST',
    'arvopaperisiirto sisään': 'TRANSFER_IN',
    'arvopaperisiirto ulos': 'TRANSFER_OUT',
    split: 'SPLIT',
  },
  signature: ['Tapahtumatyyppi', 'ISIN', 'Summa'],
}

export const OP: BrokerCsvConfig = {
  broker: 'op',
  encoding: 'utf-8',
  delimiter: ';',
  dateFormat: 'fi',
  columns: {
    tradeDate: 'Päivämäärä',
    type: 'Laji',
    instrumentName: 'Kohde',
    isin: 'ISIN',
    quantity: 'Osuudet',
    unitPrice: 'Hinta',
    fee: 'Kulut',
    currency: 'Valuutta',
    amount: 'Yhteensä',
  },
  typeMap: {
    merkintä: 'BUY', osto: 'BUY',
    lunastus: 'SELL', myynti: 'SELL',
    tuotonmaksu: 'DIVIDEND', osinko: 'DIVIDEND',
    talletus: 'DEPOSIT', nosto: 'WITHDRAWAL',
    palkkio: 'FEE', korko: 'INTEREST',
  },
  signature: ['Laji', 'Osuudet', 'Yhteensä'],
}

export const BROKER_CONFIGS: readonly BrokerCsvConfig[] = [NORDNET, OP]
```

**These configs are informed guesses at the real export formats.** Before relying on them,
download one real export from each bank, drop it in `fixtures/` (with amounts and ids altered),
and adjust `columns`, `encoding`, `delimiter` and `typeMap` to match. If Nordnet's export turns
out to be UTF-16LE and tab-delimited, that is a two-line change here and nothing else moves —
which is the entire point of the config indirection.

- [ ] **Step 6: Run the tests**

Run: `bun test src/server/import/csv.test.ts` → all PASS. Then `bun run check`.

- [ ] **Step 7: Commit**

```bash
git add src/server/import
git commit -m "feat: config-driven csv parsing for nordnet and op exports"
```

---

### Task 11: Mapping raw rows to a reviewable draft

**Files:**
- Create: `src/server/import/map.ts`
- Test: `src/server/import/map.test.ts`

**Interfaces:**
- Consumes: `parseCsv`, `BrokerCsvConfig` (Task 10); `src/core/money` (Task 2)
- Produces:
  - `type DraftTxn` — a row ready to insert, plus its source line
  - `type DraftProblem = { line: number; message: string; raw: Record<string, string> }`
  - `type Draft = { txns: DraftTxn[]; problems: DraftProblem[]; unknownIsins: Array<{ isin: string; name: string }> }`
  - `mapRows(rows: RawRow[], config: BrokerCsvConfig, knownIsins: Map<string, number>): Draft`
  - `normaliseDate(value: string, format: 'iso' | 'fi'): string`
  - `contentHash(row: DraftTxn): string`

A row that cannot be mapped becomes a `DraftProblem`, never an exception and never a silent skip.
The review screen shows problems next to good rows so the user decides.

- [ ] **Step 1: Write the failing tests**

`src/server/import/map.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { mapRows, normaliseDate, contentHash } from './map'
import { parseCsv } from './csv'
import { NORDNET, OP } from './brokers'

const fixture = (name: string) => Bun.file(`${import.meta.dir}/fixtures/${name}`).arrayBuffer()

test('normalises both date formats to ISO', () => {
  expect(normaliseDate('2025-01-10', 'iso')).toBe('2025-01-10')
  expect(normaliseDate('15.01.2025', 'fi')).toBe('2025-01-15')
  expect(() => normaliseDate('32.01.2025', 'fi')).toThrow()
  expect(() => normaliseDate('', 'iso')).toThrow()
})

test('maps the Nordnet fixture into draft transactions', async () => {
  const { rows } = parseCsv(await fixture('nordnet-sample.csv'), NORDNET)
  const known = new Map([['FI0009000681', 7]])
  const draft = mapRows(rows, NORDNET, known)

  expect(draft.problems).toEqual([])
  expect(draft.txns).toHaveLength(5)

  const buy = draft.txns[0]!
  expect(buy.type).toBe('BUY')
  expect(buy.tradeDate).toBe('2025-01-10')
  expect(buy.instrumentId).toBe(7)
  expect(buy.quantity).toBe(100_000_000)     // 100 units, scaled 1e6
  expect(buy.unitPrice).toBe(415)            // 4,15 EUR
  expect(buy.amount).toBe(-41800)
  expect(buy.fee).toBe(300)
  expect(buy.currency).toBe('EUR')
})

test('a deposit has no instrument and no quantity', async () => {
  const { rows } = parseCsv(await fixture('nordnet-sample.csv'), NORDNET)
  const draft = mapRows(rows, NORDNET, new Map([['FI0009000681', 7]]))
  const deposit = draft.txns.find((t) => t.type === 'DEPOSIT')!
  expect(deposit.instrumentId).toBeNull()
  expect(deposit.quantity).toBe(0)
  expect(deposit.amount).toBe(500000)
})

test('collects ISINs it has never seen instead of inventing instruments', async () => {
  const { rows } = parseCsv(await fixture('nordnet-sample.csv'), NORDNET)
  const draft = mapRows(rows, NORDNET, new Map([['FI0009000681', 7]]))
  expect(draft.unknownIsins).toEqual([
    { isin: 'IE00B4L5Y983', name: 'ISHARES CORE MSCI WORLD' },
  ])
  expect(draft.txns.find((t) => t.isin === 'IE00B4L5Y983')!.instrumentId).toBeNull()
})

test('maps the OP fixture with fi dates and fractional fund units', async () => {
  const { rows } = parseCsv(await fixture('op-sample.csv'), OP)
  const draft = mapRows(rows, OP, new Map([['FI0008803812', 3]]))
  const subscription = draft.txns[0]!
  expect(subscription.type).toBe('BUY')
  expect(subscription.tradeDate).toBe('2025-01-15')
  expect(subscription.quantity).toBe(12_345_600)
  expect(subscription.amount).toBe(-18827)
})

test('an unrecognised transaction type becomes a problem, not a guess', () => {
  const rows = [{ line: 2, values: {
    Id: '1', Kauppapäivä: '2025-01-10', Tapahtumatyyppi: 'YHTIÖKOKOUS', Arvopaperi: 'X',
    ISIN: 'FI0009000681', Määrä: '0', Kurssi: '0', Kokonaiskulut: '0', Valuutta: 'EUR', Summa: '0,00',
  } }]
  const draft = mapRows(rows, NORDNET, new Map([['FI0009000681', 7]]))
  expect(draft.txns).toHaveLength(0)
  expect(draft.problems[0]!.line).toBe(2)
  expect(draft.problems[0]!.message).toMatch(/YHTIÖKOKOUS/)
})

test('an unparseable amount becomes a problem carrying the raw row', () => {
  const rows = [{ line: 2, values: {
    Id: '1', Kauppapäivä: '2025-01-10', Tapahtumatyyppi: 'OSTO', Arvopaperi: 'X',
    ISIN: 'FI0009000681', Määrä: '10', Kurssi: '1,00', Kokonaiskulut: '0', Valuutta: 'EUR', Summa: 'n/a',
  } }]
  const draft = mapRows(rows, NORDNET, new Map([['FI0009000681', 7]]))
  expect(draft.txns).toHaveLength(0)
  expect(draft.problems[0]!.raw['Summa']).toBe('n/a')
})

test('content hash is stable for identical rows and differs otherwise', () => {
  const base = {
    accountId: 1, instrumentId: 7, isin: 'FI0009000681', type: 'BUY' as const,
    tradeDate: '2025-01-10', quantity: 100_000_000, unitPrice: 415,
    amount: -41800, fee: 300, tax: 0, currency: 'EUR' as const,
    fxRateEur: 100_000_000, externalId: null, line: 2,
  }
  expect(contentHash(base)).toBe(contentHash({ ...base, line: 99 }))
  expect(contentHash(base)).not.toBe(contentHash({ ...base, amount: -41801 }))
})
```

- [ ] **Step 2: Run and watch them fail**

Run: `bun test src/server/import/map.test.ts` → FAIL, `./map` missing.

- [ ] **Step 3: Implement**

`src/server/import/map.ts`:

```ts
import { parseMoney, parseQuantity } from '../../core/money'
import type { BrokerCsvConfig, CanonicalField, RawRow } from './types'

export type DraftTxn = {
  readonly line: number
  readonly accountId: number
  readonly instrumentId: number | null
  readonly isin: string | null
  readonly type: string
  readonly tradeDate: string
  readonly quantity: number
  readonly unitPrice: number | null
  readonly amount: number
  readonly fee: number
  readonly tax: number
  readonly currency: 'EUR' | 'USD'
  readonly fxRateEur: number
  readonly externalId: string | null
}

export type DraftProblem = {
  readonly line: number
  readonly message: string
  readonly raw: Record<string, string>
}

export type Draft = {
  readonly txns: DraftTxn[]
  readonly problems: DraftProblem[]
  readonly unknownIsins: Array<{ isin: string; name: string }>
}

export const normaliseDate = (value: string, format: 'iso' | 'fi'): string => {
  const trimmed = value.trim()
  const match = format === 'iso'
    ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed)
    : /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(trimmed)
  if (!match) throw new Error(`Päivämäärä ei kelpaa: ${JSON.stringify(value)}`)
  const [year, month, day] = format === 'iso'
    ? [match[1]!, match[2]!, match[3]!]
    : [match[3]!, match[2]!, match[1]!]
  const iso = `${year}-${month}-${day}`
  const parsed = new Date(`${iso}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso) {
    throw new Error(`Päivämäärää ei ole olemassa: ${JSON.stringify(value)}`)
  }
  return iso
}

export const contentHash = (txn: Omit<DraftTxn, 'line'> & { line?: number }): string => {
  const material = [
    txn.accountId, txn.type, txn.tradeDate, txn.isin ?? '',
    txn.quantity, txn.amount, txn.fee, txn.currency,
  ].join('|')
  return new Bun.CryptoHasher('sha256').update(material).digest('hex')
}

export const mapRows = (
  rows: readonly RawRow[],
  config: BrokerCsvConfig,
  knownIsins: ReadonlyMap<string, number>,
  accountId = 0,
): Draft => {
  const txns: DraftTxn[] = []
  const problems: DraftProblem[] = []
  const unknown = new Map<string, string>()

  const cell = (row: RawRow, field: CanonicalField): string => {
    const header = config.columns[field]
    return header ? (row.values[header] ?? '') : ''
  }

  for (const row of rows) {
    try {
      const label = cell(row, 'type').trim().toLowerCase()
      const type = config.typeMap[label]
      if (!type) throw new Error(`Tuntematon tapahtumatyyppi: ${cell(row, 'type')}`)

      const currencyText = cell(row, 'currency').trim().toUpperCase() || 'EUR'
      if (currencyText !== 'EUR' && currencyText !== 'USD') {
        throw new Error(`Tuettamaton valuutta: ${currencyText}`)
      }
      const currency = currencyText

      const isinText = cell(row, 'isin').trim()
      const isin = isinText === '' ? null : isinText
      const instrumentId = isin ? (knownIsins.get(isin) ?? null) : null
      if (isin && instrumentId === null) {
        unknown.set(isin, cell(row, 'instrumentName').trim())
      }

      const quantityText = cell(row, 'quantity').trim()
      const priceText = cell(row, 'unitPrice').trim()
      const feeText = cell(row, 'fee').trim()

      txns.push({
        line: row.line,
        accountId,
        instrumentId,
        isin,
        type,
        tradeDate: normaliseDate(cell(row, 'tradeDate'), config.dateFormat),
        quantity: quantityText === '' ? 0 : Number(parseQuantity(quantityText).scaled),
        unitPrice: priceText === '' || priceText === '0'
          ? null
          : Number(parseMoney(priceText, currency).minor),
        amount: Number(parseMoney(cell(row, 'amount') || '0', currency).minor),
        fee: feeText === '' ? 0 : Number(parseMoney(feeText, currency).minor),
        tax: 0,
        currency,
        fxRateEur: currency === 'EUR' ? 100_000_000 : 0,   // resolved at commit from fx_rates
        externalId: cell(row, 'externalId').trim() || null,
      })
    } catch (cause) {
      problems.push({
        line: row.line,
        message: cause instanceof Error ? cause.message : 'Rivin käsittely epäonnistui',
        raw: row.values,
      })
    }
  }

  return {
    txns,
    problems,
    unknownIsins: [...unknown].map(([isin, name]) => ({ isin, name })),
  }
}
```

`fxRateEur: 0` for USD rows is a marker, not a value: Task 12 resolves it from `fx_rates` at
commit time and refuses to commit a row still carrying `0`.

- [ ] **Step 4: Run the tests**

Run: `bun test src/server/import/map.test.ts` → all PASS. Then `bun run check`.

- [ ] **Step 5: Commit**

```bash
git add src/server/import/map.ts src/server/import/map.test.ts
git commit -m "feat: map broker rows to draft transactions with per-row problem reporting"
```

---

### Task 12: Committing an import — dedupe, FX resolution, undo

**Files:**
- Create: `src/server/import/commit.ts`, `src/server/api/imports.ts`
- Modify: `src/server/index.ts` (register `importRoutes`)
- Test: `src/server/import/commit.test.ts`

**Interfaces:**
- Consumes: `Draft`, `DraftTxn`, `contentHash` (Task 11); `openDb`, `testDb` (Task 7); `requireUser`, `assertAccountOwned` (Tasks 8, 9)
- Produces:
  - `commitDraft(db, args: { userId: string; accountId: number; kind: ImportKind; filename: string; sha256: string; draft: Draft }): { importId: number; inserted: number; skipped: number }`
  - `undoImport(db, args: { userId: string; importId: number }): { deleted: number }`
  - `importRoutes` — `POST /api/imports/preview`, `POST /api/imports/commit`, `POST /api/imports/:id/undo`

Rules enforced here, each with a test:

1. Every insert happens inside one SQLite transaction. A failure leaves the ledger untouched.
2. A row whose `(accountId, externalId)` or `(accountId, contentHash)` already exists is skipped, not inserted, and counted.
3. A USD row with no `fx_rates` entry on or before its trade date is refused — never committed at rate 1.
4. A draft with unresolved `unknownIsins` is refused. Instruments must exist first.
5. Undo deletes only rows carrying that `importId`, and only if no later transaction sells units the import introduced.

- [ ] **Step 1: Write the failing tests**

`src/server/import/commit.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { eq } from 'drizzle-orm'
import { testDb } from '../db'
import { accounts, fxRates, instruments, transactions, user } from '../db/schema'
import { commitDraft, undoImport } from './commit'
import { contentHash, type Draft, type DraftTxn } from './map'

const seed = () => {
  const { db } = testDb()
  db.insert(user).values({
    id: 'u1', name: 'Testi', email: 't@example.com', emailVerified: true,
    createdAt: new Date(), updatedAt: new Date(),
  }).run()
  const account = db.insert(accounts).values({
    userId: 'u1', name: 'Nordnet', broker: 'nordnet', baseCurrency: 'EUR',
  }).returning().get()
  const nokia = db.insert(instruments).values({
    isin: 'FI0009000681', ticker: 'NOKIA.HE', name: 'Nokia', kind: 'stock',
    currency: 'EUR', priceSource: 'yahoo', sourceKey: 'NOKIA.HE',
  }).returning().get()
  return { db, accountId: account.id, instrumentId: nokia.id }
}

const draftTxn = (over: Partial<DraftTxn> & { accountId: number }): DraftTxn => ({
  line: 2, instrumentId: null, isin: null, type: 'DEPOSIT', tradeDate: '2025-01-01',
  quantity: 0, unitPrice: null, amount: 500_00, fee: 0, tax: 0,
  currency: 'EUR', fxRateEur: 100_000_000, externalId: null, ...over,
})

const draftOf = (txns: DraftTxn[]): Draft => ({ txns, problems: [], unknownIsins: [] })

const args = (accountId: number, draft: Draft) => ({
  userId: 'u1', accountId, kind: 'csv_nordnet' as const,
  filename: 'x.csv', sha256: 'deadbeef', draft,
})

test('inserts draft rows and records the import', () => {
  const { db, accountId } = seed()
  const result = commitDraft(db, args(accountId, draftOf([draftTxn({ accountId })])))
  expect(result.inserted).toBe(1)
  expect(result.skipped).toBe(0)
  const rows = db.select().from(transactions).all()
  expect(rows[0]!.importId).toBe(result.importId)
})

test('skips a row already present by external id', () => {
  const { db, accountId } = seed()
  const row = draftTxn({ accountId, externalId: '1001' })
  commitDraft(db, args(accountId, draftOf([row])))
  const second = commitDraft(db, args(accountId, draftOf([row])))
  expect(second.inserted).toBe(0)
  expect(second.skipped).toBe(1)
  expect(db.select().from(transactions).all()).toHaveLength(1)
})

test('skips a row already present by content hash when there is no external id', () => {
  const { db, accountId } = seed()
  const row = draftTxn({ accountId })
  commitDraft(db, args(accountId, draftOf([row])))
  expect(commitDraft(db, args(accountId, draftOf([row]))).skipped).toBe(1)
})

test('refuses a draft with unresolved isins', () => {
  const { db, accountId } = seed()
  const draft: Draft = {
    txns: [draftTxn({ accountId })], problems: [],
    unknownIsins: [{ isin: 'IE00B4L5Y983', name: 'IWDA' }],
  }
  expect(() => commitDraft(db, args(accountId, draft))).toThrow(/IE00B4L5Y983/)
})

test('refuses a usd row with no fx rate on or before its trade date', () => {
  const { db, accountId, instrumentId } = seed()
  const usd = draftTxn({
    accountId, instrumentId, isin: 'FI0009000681', type: 'BUY', tradeDate: '2025-05-02',
    quantity: 10_000_000, amount: -98570, currency: 'USD', fxRateEur: 0,
  })
  expect(() => commitDraft(db, args(accountId, draftOf([usd])))).toThrow(/valuuttakurssi/i)
})

test('resolves a usd row at the newest rate on or before its trade date', () => {
  const { db, accountId, instrumentId } = seed()
  db.insert(fxRates).values([
    { date: '2025-04-30', currency: 'USD', rateEur: 93_000_000 },
    { date: '2025-05-02', currency: 'USD', rateEur: 92_000_000 },
    { date: '2025-05-05', currency: 'USD', rateEur: 91_000_000 },
  ]).run()
  const usd = draftTxn({
    accountId, instrumentId, isin: 'FI0009000681', type: 'BUY', tradeDate: '2025-05-03',
    quantity: 10_000_000, amount: -98570, currency: 'USD', fxRateEur: 0,
  })
  commitDraft(db, args(accountId, draftOf([usd])))
  expect(db.select().from(transactions).all()[0]!.fxRateEur).toBe(92_000_000)
})

test('a failure part-way through leaves the ledger untouched', () => {
  const { db, accountId } = seed()
  const good = draftTxn({ accountId, externalId: 'a' })
  const bad = draftTxn({ accountId, externalId: 'b', currency: 'USD', fxRateEur: 0 })
  expect(() => commitDraft(db, args(accountId, draftOf([good, bad])))).toThrow()
  expect(db.select().from(transactions).all()).toHaveLength(0)
})

test('undo removes exactly the rows of that import', () => {
  const { db, accountId } = seed()
  const first = commitDraft(db, args(accountId, draftOf([draftTxn({ accountId, externalId: 'a' })])))
  commitDraft(db, args(accountId, draftOf([draftTxn({ accountId, externalId: 'b' })])))
  expect(undoImport(db, { userId: 'u1', importId: first.importId }).deleted).toBe(1)
  expect(db.select().from(transactions).all()).toHaveLength(1)
})

test('undo refuses when a later sale depends on units the import introduced', () => {
  const { db, accountId, instrumentId } = seed()
  const buy = commitDraft(db, args(accountId, draftOf([draftTxn({
    accountId, instrumentId, isin: 'FI0009000681', type: 'BUY',
    tradeDate: '2025-01-10', quantity: 100_000_000, amount: -41800, externalId: 'buy',
  })])))
  commitDraft(db, args(accountId, draftOf([draftTxn({
    accountId, instrumentId, isin: 'FI0009000681', type: 'SELL',
    tradeDate: '2025-04-01', quantity: 40_000_000, amount: 18100, externalId: 'sell',
  })])))
  expect(() => undoImport(db, { userId: 'u1', importId: buy.importId })).toThrow(/myöhempi/i)
})

test('undo refuses an import belonging to another user', () => {
  const { db, accountId } = seed()
  const created = commitDraft(db, args(accountId, draftOf([draftTxn({ accountId })])))
  expect(() => undoImport(db, { userId: 'someone-else', importId: created.importId })).toThrow()
})
```

- [ ] **Step 2: Run and watch them fail**

Run: `bun test src/server/import/commit.test.ts` → FAIL, `./commit` missing.

- [ ] **Step 3: Implement**

`src/server/import/commit.ts`:

```ts
import { and, desc, eq, gt, lte, sql } from 'drizzle-orm'
import type { openDb } from '../db'
import { fxRates, imports, transactions } from '../db/schema'
import { HttpError } from '../auth-guard'
import { contentHash, type Draft } from './map'

type Db = ReturnType<typeof openDb>['db']
export type ImportKind = 'csv_nordnet' | 'csv_op' | 'pdf' | 'vision' | 'manual'

const fxRateOn = (db: Db, currency: 'USD', date: string): number | null => {
  const row = db.select().from(fxRates)
    .where(and(eq(fxRates.currency, currency), lte(fxRates.date, date)))
    .orderBy(desc(fxRates.date)).limit(1).get()
  return row?.rateEur ?? null
}

export const commitDraft = (
  db: Db,
  args: {
    userId: string; accountId: number; kind: ImportKind
    filename: string; sha256: string; draft: Draft
  },
): { importId: number; inserted: number; skipped: number } => {
  const { draft } = args
  if (draft.unknownIsins.length > 0) {
    throw new HttpError(400, `Tuntemattomat arvopaperit on lisättävä ensin: ${
      draft.unknownIsins.map((u) => u.isin).join(', ')}`)
  }

  let inserted = 0
  let skipped = 0
  let importId = 0

  db.transaction((tx) => {
    const created = tx.insert(imports).values({
      userId: args.userId, kind: args.kind, filename: args.filename,
      sha256: args.sha256, status: 'committed', rowCount: draft.txns.length,
    }).returning().get()
    importId = created.id

    for (const row of draft.txns) {
      let fxRateEur = row.fxRateEur
      if (row.currency !== 'EUR' && fxRateEur === 0) {
        const rate = fxRateOn(tx as unknown as Db, row.currency, row.tradeDate)
        if (rate === null) {
          throw new HttpError(400,
            `Valuuttakurssia ${row.currency} ei löydy päivälle ${row.tradeDate} (rivi ${row.line})`)
        }
        fxRateEur = rate
      }

      const values = {
        accountId: args.accountId,
        instrumentId: row.instrumentId,
        type: row.type as typeof transactions.$inferInsert.type,
        tradeDate: row.tradeDate,
        quantity: row.quantity,
        unitPrice: row.unitPrice,
        amount: row.amount,
        fee: row.fee,
        tax: row.tax,
        currency: row.currency,
        fxRateEur,
        externalId: row.externalId,
        contentHash: contentHash({ ...row, accountId: args.accountId }),
        importId,
      }

      const duplicate = tx.select({ id: transactions.id }).from(transactions).where(
        row.externalId
          ? and(eq(transactions.accountId, args.accountId), eq(transactions.externalId, row.externalId))
          : and(eq(transactions.accountId, args.accountId), eq(transactions.contentHash, values.contentHash)),
      ).get()

      if (duplicate) { skipped++; continue }
      tx.insert(transactions).values(values).run()
      inserted++
    }
  })

  return { importId, inserted, skipped }
}

export const undoImport = (
  db: Db,
  args: { userId: string; importId: number },
): { deleted: number } => {
  const record = db.select().from(imports)
    .where(and(eq(imports.id, args.importId), eq(imports.userId, args.userId))).get()
  if (!record) throw new HttpError(404, 'Tuontia ei löydy')
  if (record.status === 'undone') throw new HttpError(409, 'Tuonti on jo peruttu')

  let deleted = 0
  db.transaction((tx) => {
    const rows = tx.select().from(transactions).where(eq(transactions.importId, args.importId)).all()

    for (const row of rows) {
      if (row.instrumentId === null) continue
      const later = tx.select({ id: transactions.id }).from(transactions).where(and(
        eq(transactions.accountId, row.accountId),
        eq(transactions.instrumentId, row.instrumentId),
        gt(transactions.tradeDate, row.tradeDate),
        sql`${transactions.importId} IS NOT ${args.importId}`,
      )).get()
      if (later) {
        throw new HttpError(409,
          'Tuontia ei voi perua: myöhempi tapahtuma käyttää sen tuomia osuuksia')
      }
    }

    deleted = rows.length
    tx.delete(transactions).where(eq(transactions.importId, args.importId)).run()
    tx.update(imports).set({ status: 'undone' }).where(eq(imports.id, args.importId)).run()
  })

  return { deleted }
}
```

- [ ] **Step 4: Implement the routes**

`src/server/api/imports.ts`:

```ts
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { openDb } from '../db'
import { instruments } from '../db/schema'
import { requireUser } from '../auth-guard'
import { HttpError, handle, json } from '../http'
import { assertAccountOwned } from './accounts'
import { detectBroker, parseCsv } from '../import/csv'
import { mapRows } from '../import/map'
import { commitDraft, undoImport } from '../import/commit'

const { db } = openDb()
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024

const readUpload = async (request: Request): Promise<{ file: File; accountId: number }> => {
  const form = await request.formData()
  const file = form.get('file')
  const accountId = Number(form.get('accountId'))
  if (!(file instanceof File)) throw new HttpError(400, 'Tiedosto puuttuu')
  if (file.size > MAX_UPLOAD_BYTES) throw new HttpError(413, 'Tiedosto on liian suuri (max 5 MB)')
  if (!Number.isInteger(accountId)) throw new HttpError(400, 'Tili puuttuu')
  return { file, accountId }
}

const buildDraft = async (file: File, accountId: number) => {
  const bytes = await file.arrayBuffer()
  const headerProbe = new TextDecoder('utf-8').decode(bytes.slice(0, 4096)).split(/\r?\n/)[0] ?? ''
  const config = detectBroker(headerProbe.split(';').map((h) => h.trim()))
  if (!config) throw new HttpError(400, 'Tuntematon CSV-muoto: välittäjää ei tunnistettu')

  const { rows } = parseCsv(bytes, config)
  const knownIsins = new Map(
    db.select({ isin: instruments.isin, id: instruments.id }).from(instruments).all()
      .map((i) => [i.isin, i.id] as const),
  )
  const sha256 = new Bun.CryptoHasher('sha256').update(new Uint8Array(bytes)).digest('hex')
  return { config, draft: mapRows(rows, config, knownIsins, accountId), sha256 }
}

export const importRoutes = {
  '/api/imports/preview': {
    POST: handle(async (request) => {
      const { userId } = await requireUser(request)
      const { file, accountId } = await readUpload(request)
      assertAccountOwned(userId, accountId)
      const { config, draft, sha256 } = await buildDraft(file, accountId)
      return json({ broker: config.broker, filename: file.name, sha256, ...draft })
    }),
  },
  '/api/imports/commit': {
    POST: handle(async (request) => {
      const { userId } = await requireUser(request)
      const { file, accountId } = await readUpload(request)
      assertAccountOwned(userId, accountId)
      const { config, draft, sha256 } = await buildDraft(file, accountId)
      return json(commitDraft(db, {
        userId, accountId, filename: file.name, sha256, draft,
        kind: config.broker === 'nordnet' ? 'csv_nordnet' : 'csv_op',
      }), 201)
    }),
  },
  '/api/imports/:id/undo': {
    POST: handle(async (request) => {
      const { userId } = await requireUser(request)
      const importId = z.coerce.number().int().positive()
        .parse(new URL(request.url).pathname.split('/').at(-2))
      return json(undoImport(db, { userId, importId }))
    }),
  },
}
```

Preview and commit both re-parse the uploaded file. That is deliberate: no server-side draft
state to expire, invalidate, or leak between users. The file is small and the parse is cheap.

Register the routes in `src/server/index.ts`:

```ts
import { importRoutes } from './api/imports'
// ... inside routes:
    ...importRoutes,
```

- [ ] **Step 5: Run the tests**

Run: `bun test src/server/import/commit.test.ts` → all PASS.

If the "failure part-way through" test leaves rows behind, the `db.transaction` callback is
swallowing the throw — it must propagate so Drizzle rolls back. If the `tx as unknown as Db` cast
trips `anti-slop/require-safety-comment-for-type-assertion`, add the required comment naming the
invariant (the transaction handle exposes the same `select` surface), or better, type
`fxRateOn`'s first parameter as the minimal structural type it actually uses.

Then `bun run check`.

- [ ] **Step 6: Commit**

```bash
git add src/server/import/commit.ts src/server/import/commit.test.ts src/server/api/imports.ts src/server/index.ts
git commit -m "feat: transactional import commit with dedupe, fx resolution and guarded undo"
```

---

### Task 13: Opening positions

**Files:**
- Create: `src/server/api/opening.ts`
- Modify: `src/server/index.ts`
- Test: `src/server/api/opening.test.ts`

**Interfaces:**
- Consumes: `openDb`/`testDb` (Task 7), `requireUser` (Task 8), `assertAccountOwned` (Task 9), `contentHash` (Task 11)
- Produces: `openingRoutes` — `POST /api/opening-positions`; `createOpeningPosition(db, args): { transactionId: number }`

Records a holding that predates the available broker history as a `TRANSFER_IN` with a stated
acquisition date and total cost. Without it, positions with no purchase record report infinite
return and a zero cost basis.

- [ ] **Step 1: Write the failing tests**

`src/server/api/opening.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { testDb } from '../db'
import { accounts, instruments, transactions, user } from '../db/schema'
import { createOpeningPosition } from './opening'

const seed = () => {
  const { db } = testDb()
  db.insert(user).values({
    id: 'u1', name: 'T', email: 't@e.fi', emailVerified: true,
    createdAt: new Date(), updatedAt: new Date(),
  }).run()
  const account = db.insert(accounts).values({
    userId: 'u1', name: 'Nordnet', broker: 'nordnet', baseCurrency: 'EUR',
  }).returning().get()
  const inst = db.insert(instruments).values({
    isin: 'FI0009000681', ticker: 'NOKIA.HE', name: 'Nokia', kind: 'stock',
    currency: 'EUR', priceSource: 'yahoo', sourceKey: 'NOKIA.HE',
  }).returning().get()
  return { db, accountId: account.id, instrumentId: inst.id }
}

test('writes a TRANSFER_IN carrying the stated cost', () => {
  const { db, accountId, instrumentId } = seed()
  createOpeningPosition(db, {
    accountId, instrumentId, acquiredOn: '2018-06-01',
    quantity: 250_000_000, costEurMinor: 112_500, note: 'Siirretty Nordnetiin',
  })
  const row = db.select().from(transactions).all()[0]!
  expect(row.type).toBe('TRANSFER_IN')
  expect(row.tradeDate).toBe('2018-06-01')
  expect(row.quantity).toBe(250_000_000)
  expect(row.amount).toBe(-112_500)
  expect(row.currency).toBe('EUR')
  expect(row.fxRateEur).toBe(100_000_000)
  expect(row.importId).toBeNull()
})

test('rejects a non-positive quantity or a negative cost', () => {
  const { db, accountId, instrumentId } = seed()
  const base = { accountId, instrumentId, acquiredOn: '2018-06-01', costEurMinor: 100, note: null }
  expect(() => createOpeningPosition(db, { ...base, quantity: 0 })).toThrow()
  expect(() => createOpeningPosition(db, { ...base, quantity: -1 })).toThrow()
  expect(() => createOpeningPosition(db, { ...base, quantity: 1, costEurMinor: -5 })).toThrow()
})

test('rejects a duplicate opening position for the same instrument and date', () => {
  const { db, accountId, instrumentId } = seed()
  const args = {
    accountId, instrumentId, acquiredOn: '2018-06-01',
    quantity: 250_000_000, costEurMinor: 112_500, note: null,
  }
  createOpeningPosition(db, args)
  expect(() => createOpeningPosition(db, args)).toThrow(/UNIQUE|jo kirjattu/i)
})
```

- [ ] **Step 2: Run and watch them fail**

Run: `bun test src/server/api/opening.test.ts` → FAIL, `./opening` missing.

- [ ] **Step 3: Implement**

`src/server/api/opening.ts`:

```ts
import { z } from 'zod'
import type { openDb } from '../db'
import { openDb as open } from '../db'
import { transactions } from '../db/schema'
import { requireUser } from '../auth-guard'
import { handle, json } from '../http'
import { assertAccountOwned } from './accounts'
import { contentHash } from '../import/map'

type Db = ReturnType<typeof openDb>['db']

export const OpeningPosition = z.object({
  accountId: z.number().int().positive(),
  instrumentId: z.number().int().positive(),
  acquiredOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Päivämäärän muoto on vvvv-kk-pp'),
  quantity: z.number().int().positive('Osuusmäärän on oltava positiivinen'),
  costEurMinor: z.number().int().nonnegative('Hankintameno ei voi olla negatiivinen'),
  note: z.string().max(500).nullable().default(null),
})

export const createOpeningPosition = (
  db: Db,
  input: z.input<typeof OpeningPosition>,
): { transactionId: number } => {
  const args = OpeningPosition.parse(input)
  const row = {
    accountId: args.accountId,
    instrumentId: args.instrumentId,
    type: 'TRANSFER_IN' as const,
    tradeDate: args.acquiredOn,
    quantity: args.quantity,
    unitPrice: null,
    amount: -args.costEurMinor,
    fee: 0,
    tax: 0,
    currency: 'EUR' as const,
    fxRateEur: 100_000_000,
    externalId: null,
    importId: null,
    note: args.note,
  }
  const created = db.insert(transactions)
    .values({ ...row, contentHash: contentHash({ ...row, isin: String(args.instrumentId) }) })
    .returning().get()
  return { transactionId: created.id }
}

const { db } = open()

export const openingRoutes = {
  '/api/opening-positions': {
    POST: handle(async (request) => {
      const { userId } = await requireUser(request)
      const body = OpeningPosition.parse(await request.json())
      assertAccountOwned(userId, body.accountId)
      return json(createOpeningPosition(db, body), 201)
    }),
  },
}
```

Register `...openingRoutes` in `src/server/index.ts`.

- [ ] **Step 4: Run the tests**

Run: `bun test src/server/api/opening.test.ts` → PASS. Then `bun run check`.

- [ ] **Step 5: Commit**

```bash
git add src/server/api/opening.ts src/server/api/opening.test.ts src/server/index.ts
git commit -m "feat: opening positions for holdings predating broker history"
```

---

### Task 14: Price sources

**Files:**
- Create: `src/server/prices/types.ts`, `src/server/prices/yahoo.ts`, `src/server/prices/funds.ts`, `src/server/prices/registry.ts`
- Test: `src/server/prices/yahoo.test.ts`, `src/server/prices/funds.test.ts`
- Test fixtures: `src/server/prices/fixtures/yahoo-nokia.json`, `src/server/prices/fixtures/op-suomi.html`

**Interfaces:**
- Consumes: `src/core/money` (Task 2), `src/core/types` (Task 3)
- Produces:
  - `type FetchedPrice = { date: string; closeMinor: number; currency: 'EUR' | 'USD' }`
  - `interface PriceSource { id: PriceSourceId; fetch(args: { sourceKey: string; from: string; to: string; fetchImpl?: typeof fetch }): Promise<FetchedPrice[]> }`
  - `YAHOO`, `NORDNET_FUND`, `OP_FUND`, `SPANKKI_FUND`, `DANSKE_FUND`, `MANUAL`
  - `sourceFor(id: PriceSourceId): PriceSource`

Every source takes an injectable `fetchImpl` defaulting to global `fetch`. Tests pass a stub that
returns a recorded fixture — a real dependency seam, not a module mock, which is what
`anti-slop/no-module-mocking` requires and what keeps the suite offline.

- [ ] **Step 1: Record the fixtures**

Run these once, by hand, and commit the results. They are the only time the project touches the
network outside the running server:

```bash
mkdir -p src/server/prices/fixtures
curl -s 'https://query1.finance.yahoo.com/v8/finance/chart/NOKIA.HE?range=5d&interval=1d' \
  > src/server/prices/fixtures/yahoo-nokia.json
```

For `op-suomi.html`, save the OP fund page that shows the daily NAV. If the NAV is rendered by
client-side JavaScript rather than present in the HTML, record the JSON endpoint the page calls
instead and name the fixture after it — and change `OP_FUND` to hit that endpoint. Discovering
this is part of the task.

- [ ] **Step 2: Write the failing tests**

`src/server/prices/yahoo.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { YAHOO } from './yahoo'

const stubFetch = async (): Promise<Response> =>
  new Response(await Bun.file(`${import.meta.dir}/fixtures/yahoo-nokia.json`).text(), {
    headers: { 'content-type': 'application/json' },
  })

test('parses the chart payload into dated closes in minor units', async () => {
  const prices = await YAHOO.fetch({
    sourceKey: 'NOKIA.HE', from: '2025-01-01', to: '2025-12-31', fetchImpl: stubFetch,
  })
  expect(prices.length).toBeGreaterThan(0)
  for (const point of prices) {
    expect(point.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(Number.isInteger(point.closeMinor)).toBe(true)
    expect(point.closeMinor).toBeGreaterThan(0)
    expect(['EUR', 'USD']).toContain(point.currency)
  }
})

test('drops days whose close is null instead of emitting zero', async () => {
  const withGap = async (): Promise<Response> => Response.json({
    chart: { result: [{
      meta: { currency: 'EUR' },
      timestamp: [1735689600, 1735776000],
      indicators: { quote: [{ close: [4.15, null] }] },
    }], error: null },
  })
  const prices = await YAHOO.fetch({ sourceKey: 'X', from: '2025-01-01', to: '2025-01-02', fetchImpl: withGap })
  expect(prices).toHaveLength(1)
})

test('rejects a payload that does not match the expected schema', async () => {
  const garbage = async (): Promise<Response> => Response.json({ unexpected: true })
  await expect(YAHOO.fetch({ sourceKey: 'X', from: '2025-01-01', to: '2025-01-02', fetchImpl: garbage }))
    .rejects.toThrow()
})

test('surfaces a non-200 response as an error', async () => {
  const failing = async (): Promise<Response> => new Response('rate limited', { status: 429 })
  await expect(YAHOO.fetch({ sourceKey: 'X', from: '2025-01-01', to: '2025-01-02', fetchImpl: failing }))
    .rejects.toThrow(/429/)
})
```

- [ ] **Step 3: Run and watch them fail**

Run: `bun test src/server/prices` → FAIL, modules missing.

- [ ] **Step 4: Implement the shared types**

`src/server/prices/types.ts`:

```ts
import type { PriceSourceId } from '../../core/types'

export type FetchedPrice = {
  readonly date: string
  readonly closeMinor: number
  readonly currency: 'EUR' | 'USD'
}

export type FetchArgs = {
  readonly sourceKey: string
  readonly from: string
  readonly to: string
  readonly fetchImpl?: typeof fetch
}

export type PriceSource = {
  readonly id: PriceSourceId
  fetch(args: FetchArgs): Promise<FetchedPrice[]>
}

export const toMinor = (value: number): number => Math.round(value * 100)

export const requireOk = async (response: Response, label: string): Promise<Response> => {
  if (!response.ok) {
    throw new Error(`${label} vastasi ${response.status} ${response.statusText}`)
  }
  return response
}
```

- [ ] **Step 5: Implement the Yahoo source**

`src/server/prices/yahoo.ts`:

```ts
import { z } from 'zod'
import { requireOk, toMinor, type FetchArgs, type FetchedPrice, type PriceSource } from './types'

const ChartResponse = z.object({
  chart: z.object({
    result: z.array(z.object({
      meta: z.object({ currency: z.string() }),
      timestamp: z.array(z.number()),
      indicators: z.object({
        quote: z.array(z.object({ close: z.array(z.number().nullable()) })).min(1),
      }),
    })).min(1),
  }),
})

export const YAHOO: PriceSource = {
  id: 'yahoo',
  async fetch({ sourceKey, from, to, fetchImpl = fetch }: FetchArgs): Promise<FetchedPrice[]> {
    const period1 = Math.floor(Date.parse(from) / 1000)
    const period2 = Math.floor(Date.parse(to) / 1000) + 86_400
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${
      encodeURIComponent(sourceKey)}?period1=${period1}&period2=${period2}&interval=1d`

    const response = await requireOk(await fetchImpl(url), `Yahoo ${sourceKey}`)
    const payload = ChartResponse.parse(await response.json())
    const result = payload.chart.result[0]!
    const currency = result.meta.currency.toUpperCase()
    if (currency !== 'EUR' && currency !== 'USD') {
      throw new Error(`Tuettamaton valuutta ${currency} arvopaperille ${sourceKey}`)
    }
    const closes = result.indicators.quote[0]!.close

    return result.timestamp.flatMap((seconds, index) => {
      const close = closes[index]
      if (close === null || close === undefined) return []
      return [{
        date: new Date(seconds * 1000).toISOString().slice(0, 10),
        closeMinor: toMinor(close),
        currency,
      }]
    })
  },
}
```

- [ ] **Step 6: Implement the fund sources and the registry**

`src/server/prices/funds.ts` — one source per fund house, each parsing its own response into
`FetchedPrice[]`. Write `NORDNET_FUND` first, since it covers the most holdings:

```ts
import { z } from 'zod'
import { requireOk, toMinor, type FetchArgs, type FetchedPrice, type PriceSource } from './types'

const NordnetSeries = z.array(z.object({
  time: z.number(),          // epoch milliseconds
  last: z.number(),
}))

export const NORDNET_FUND: PriceSource = {
  id: 'nordnet_fund',
  async fetch({ sourceKey, from, to, fetchImpl = fetch }: FetchArgs): Promise<FetchedPrice[]> {
    const url = `https://www.nordnet.fi/api/2/instruments/historical/prices/${
      encodeURIComponent(sourceKey)}?from=${from}&to=${to}`
    const response = await requireOk(await fetchImpl(url), `Nordnet ${sourceKey}`)
    const payload = z.array(z.object({ pricepoints: NordnetSeries })).min(1).parse(await response.json())
    return payload[0]!.pricepoints.map((p) => ({
      date: new Date(p.time).toISOString().slice(0, 10),
      closeMinor: toMinor(p.last),
      currency: 'EUR' as const,
    }))
  },
}

/** Shared shape for the bank fund pages: locate the NAV in the document, one value, today's date. */
const htmlNavSource = (
  id: 'op_fund' | 'spankki_fund' | 'danske_fund',
  urlFor: (sourceKey: string) => string,
  extract: (html: string) => number | null,
): PriceSource => ({
  id,
  async fetch({ sourceKey, to, fetchImpl = fetch }: FetchArgs): Promise<FetchedPrice[]> {
    const response = await requireOk(await fetchImpl(urlFor(sourceKey)), `${id} ${sourceKey}`)
    const nav = extract(await response.text())
    if (nav === null) throw new Error(`${id}: NAV-arvoa ei löytynyt sivulta (${sourceKey})`)
    return [{ date: to, closeMinor: toMinor(nav), currency: 'EUR' }]
  },
})

const parseFiNumber = (text: string): number => Number(text.replace(/\s/g, '').replace(',', '.'))

export const OP_FUND = htmlNavSource(
  'op_fund',
  (key) => `https://www.op.fi/private/investments/funds/${encodeURIComponent(key)}`,
  (html) => {
    const match = /data-nav="([\d\s,.]+)"/.exec(html)
    return match ? parseFiNumber(match[1]!) : null
  },
)

export const SPANKKI_FUND = htmlNavSource(
  'spankki_fund',
  (key) => `https://www.s-pankki.fi/fi/saastaminen-ja-sijoittaminen/rahastot/${encodeURIComponent(key)}`,
  (html) => {
    const match = /Arvo<\/[^>]+>\s*<[^>]+>([\d\s,.]+)/.exec(html)
    return match ? parseFiNumber(match[1]!) : null
  },
)

export const DANSKE_FUND = htmlNavSource(
  'danske_fund',
  (key) => `https://danskeinvest.fi/fund/${encodeURIComponent(key)}`,
  (html) => {
    const match = /class="nav-value"[^>]*>([\d\s,.]+)/.exec(html)
    return match ? parseFiNumber(match[1]!) : null
  },
)

export const MANUAL: PriceSource = {
  id: 'manual',
  async fetch(): Promise<FetchedPrice[]> { return [] },
}
```

**Every URL and every regex above is a starting guess.** Open each fund page, find where the NAV
actually lives, and correct `urlFor` and `extract` before writing the fixture. Record one fixture
per source and add a test per source mirroring `yahoo.test.ts`: parses a good fixture, throws on a
page with no NAV, throws on a non-200. If a bank turns out to require an authenticated session,
set that instrument's `price_source` to `manual`, note it in `docs/` and move on — Task 15's stale
badge covers it and Phase 1 still ships.

`src/server/prices/registry.ts`:

```ts
import type { PriceSourceId } from '../../core/types'
import { YAHOO } from './yahoo'
import { DANSKE_FUND, MANUAL, NORDNET_FUND, OP_FUND, SPANKKI_FUND } from './funds'
import type { PriceSource } from './types'

const SOURCES: Record<PriceSourceId, PriceSource> = {
  yahoo: YAHOO,
  nordnet_fund: NORDNET_FUND,
  op_fund: OP_FUND,
  spankki_fund: SPANKKI_FUND,
  danske_fund: DANSKE_FUND,
  manual: MANUAL,
}

export const sourceFor = (id: PriceSourceId): PriceSource => SOURCES[id]
```

- [ ] **Step 7: Run the tests**

Run: `bun test src/server/prices` → all PASS. Confirm the suite makes no network calls: run it
with the network off; it must still pass. Then `bun run check`.

- [ ] **Step 8: Commit**

```bash
git add src/server/prices
git commit -m "feat: pluggable price sources for listed securities and finnish fund navs"
```

---

### Task 15: FX ingestion, refresh scheduler and backfill

**Files:**
- Create: `src/server/fx.ts`, `src/server/prices/refresh.ts`
- Modify: `src/server/index.ts` (register the cron job)
- Test: `src/server/fx.test.ts`, `src/server/prices/refresh.test.ts`
- Test fixture: `src/server/fixtures/ecb-eurofxref.csv`

**Interfaces:**
- Consumes: `sourceFor` (Task 14), `openDb`/`testDb` (Task 7)
- Produces:
  - `parseEcbCsv(text: string, wanted: Set<string>): Array<{ date: string; currency: string; rateEur: number }>`
  - `refreshFxRates(db, opts?: { fetchImpl?: typeof fetch }): Promise<{ inserted: number }>`
  - `refreshPrices(db, opts?: { fetchImpl?: typeof fetch; today?: string }): Promise<{ ok: number; failed: number }>`
  - `backfillInstrument(db, instrumentId: number, opts?): Promise<{ inserted: number }>`
  - `startScheduler(db): CronJob`

The ECB publishes `eurofxref.csv` as EUR-base (1 EUR = N USD). We store the inverse — EUR per one
unit of the foreign currency — because that is the direction `toEur` multiplies by.

- [ ] **Step 1: Create the ECB fixture**

`src/server/fixtures/ecb-eurofxref.csv` — the daily file's real shape, two lines:

```
Date, USD, JPY, GBP, SEK, NOK
27 August 2026, 1.0870, 158.42, 0.8412, 11.2340, 11.5670
```

- [ ] **Step 2: Write the failing tests**

`src/server/fx.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { parseEcbCsv, refreshFxRates } from './fx'
import { testDb } from './db'
import { fxRates } from './db/schema'

const fixtureText = () => Bun.file(`${import.meta.dir}/fixtures/ecb-eurofxref.csv`).text()

test('inverts the ECB rate to EUR per unit of foreign currency', async () => {
  const parsed = parseEcbCsv(await fixtureText(), new Set(['USD']))
  expect(parsed).toHaveLength(1)
  expect(parsed[0]!.date).toBe('2026-08-27')
  expect(parsed[0]!.currency).toBe('USD')
  // 1 EUR = 1.0870 USD  ->  1 USD = 0.91996...  EUR, scaled 1e8
  expect(parsed[0]!.rateEur).toBe(91_996_320)
})

test('ignores currencies we do not hold', async () => {
  const parsed = parseEcbCsv(await fixtureText(), new Set(['USD']))
  expect(parsed.map((r) => r.currency)).toEqual(['USD'])
})

test('rejects a file whose header is not the ECB layout', () => {
  expect(() => parseEcbCsv('nope\n1;2\n', new Set(['USD']))).toThrow(/ECB/i)
})

test('stores rates idempotently', async () => {
  const { db } = testDb()
  const stub = async (): Promise<Response> => new Response(await fixtureText())
  expect((await refreshFxRates(db, { fetchImpl: stub })).inserted).toBe(1)
  expect((await refreshFxRates(db, { fetchImpl: stub })).inserted).toBe(0)
  expect(db.select().from(fxRates).all()).toHaveLength(1)
})
```

`src/server/prices/refresh.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { testDb } from '../db'
import { instruments, priceFetchLog, prices } from '../db/schema'
import { refreshPrices } from './refresh'

const seedInstrument = (db: ReturnType<typeof testDb>['db'], over: Partial<typeof instruments.$inferInsert> = {}) =>
  db.insert(instruments).values({
    isin: over.isin ?? 'FI0009000681', ticker: 'NOKIA.HE', name: 'Nokia', kind: 'stock',
    currency: 'EUR', priceSource: 'yahoo', sourceKey: 'NOKIA.HE', ...over,
  }).returning().get()

const yahooStub = async (): Promise<Response> => Response.json({
  chart: { result: [{
    meta: { currency: 'EUR' },
    timestamp: [1756252800],
    indicators: { quote: [{ close: [4.31] }] },
  }] },
})

test('writes one price row per instrument and logs success', async () => {
  const { db } = testDb()
  seedInstrument(db)
  const result = await refreshPrices(db, { fetchImpl: yahooStub, today: '2026-08-27' })
  expect(result).toEqual({ ok: 1, failed: 0 })
  expect(db.select().from(prices).all()[0]!.close).toBe(431)
  expect(db.select().from(priceFetchLog).all()[0]!.ok).toBe(true)
})

test('one failing source does not stop the others', async () => {
  const { db } = testDb()
  seedInstrument(db)
  seedInstrument(db, { isin: 'FI0008803812', name: 'OP-Suomi A', kind: 'fund', priceSource: 'op_fund', sourceKey: 'op-suomi-a', ticker: null })
  const mixed = async (url: string | URL | Request): Promise<Response> =>
    String(url).includes('op.fi') ? new Response('down', { status: 503 }) : yahooStub()

  const result = await refreshPrices(db, { fetchImpl: mixed, today: '2026-08-27' })
  expect(result).toEqual({ ok: 1, failed: 1 })
  const log = db.select().from(priceFetchLog).all()
  expect(log.filter((l) => !l.ok)[0]!.message).toContain('503')
})

test('skips manual instruments without logging a failure', async () => {
  const { db } = testDb()
  seedInstrument(db, { priceSource: 'manual', sourceKey: 'n/a' })
  expect(await refreshPrices(db, { fetchImpl: yahooStub, today: '2026-08-27' })).toEqual({ ok: 0, failed: 0 })
})

test('re-running the same day overwrites rather than duplicating', async () => {
  const { db } = testDb()
  seedInstrument(db)
  await refreshPrices(db, { fetchImpl: yahooStub, today: '2026-08-27' })
  await refreshPrices(db, { fetchImpl: yahooStub, today: '2026-08-27' })
  expect(db.select().from(prices).all()).toHaveLength(1)
})
```

- [ ] **Step 3: Run and watch them fail**

Run: `bun test src/server/fx.test.ts src/server/prices/refresh.test.ts` → FAIL, modules missing.

- [ ] **Step 4: Implement FX**

`src/server/fx.ts`:

```ts
import { sql } from 'drizzle-orm'
import type { openDb } from './db'
import { fxRates, transactions } from './db/schema'

type Db = ReturnType<typeof openDb>['db']

const ECB_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref.csv'

export const parseEcbCsv = (
  text: string,
  wanted: ReadonlySet<string>,
): Array<{ date: string; currency: string; rateEur: number }> => {
  const [headerLine, valueLine] = text.split(/\r?\n/)
  if (!headerLine || !valueLine || !/^Date/i.test(headerLine.trim())) {
    throw new Error('ECB-tiedoston muoto ei kelpaa: otsikkorivi puuttuu')
  }
  const headers = headerLine.split(',').map((h) => h.trim())
  const values = valueLine.split(',').map((v) => v.trim())

  const date = new Date(`${values[0]} UTC`)
  if (Number.isNaN(date.getTime())) {
    throw new Error(`ECB-tiedoston päivämäärä ei kelpaa: ${values[0]}`)
  }
  const isoDate = date.toISOString().slice(0, 10)

  const out: Array<{ date: string; currency: string; rateEur: number }> = []
  for (let i = 1; i < headers.length; i++) {
    const currency = headers[i]!
    if (!wanted.has(currency)) continue
    const perEur = Number(values[i])
    if (!Number.isFinite(perEur) || perEur <= 0) continue
    // ECB gives foreign-per-EUR; we store EUR-per-foreign, scaled 1e8.
    out.push({ date: isoDate, currency, rateEur: Math.round((1 / perEur) * 1e8) })
  }
  return out
}

export const refreshFxRates = async (
  db: Db,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<{ inserted: number }> => {
  const fetchImpl = opts.fetchImpl ?? fetch
  const held = db.selectDistinct({ currency: transactions.currency }).from(transactions).all()
    .map((r) => r.currency).filter((c) => c !== 'EUR')
  const wanted = new Set(held.length > 0 ? held : ['USD'])

  const response = await fetchImpl(ECB_URL)
  if (!response.ok) throw new Error(`ECB vastasi ${response.status}`)
  const rows = parseEcbCsv(await response.text(), wanted)

  let inserted = 0
  db.transaction((tx) => {
    for (const row of rows) {
      const result = tx.insert(fxRates)
        .values({ date: row.date, currency: row.currency as 'USD', rateEur: row.rateEur })
        .onConflictDoNothing().run()
      if (result.changes > 0) inserted++
    }
  })
  return { inserted }
}
```

`refreshFxRates` defaults to USD when the ledger is empty so the very first import has a rate to
resolve against.

- [ ] **Step 5: Implement refresh, backfill and the scheduler**

`src/server/prices/refresh.ts`:

```ts
import { asc, eq } from 'drizzle-orm'
import type { openDb } from '../db'
import { instruments, priceFetchLog, prices, transactions } from '../db/schema'
import { sourceFor } from './registry'

type Db = ReturnType<typeof openDb>['db']

const today = (): string => new Date().toISOString().slice(0, 10)

const writePrices = (db: Db, instrumentId: number, source: string, points: readonly {
  date: string; closeMinor: number; currency: 'EUR' | 'USD'
}[]): void => {
  db.transaction((tx) => {
    for (const point of points) {
      tx.insert(prices).values({
        instrumentId, date: point.date, close: point.closeMinor,
        currency: point.currency, source, fetchedAt: new Date(),
      }).onConflictDoUpdate({
        target: [prices.instrumentId, prices.date],
        set: { close: point.closeMinor, currency: point.currency, source, fetchedAt: new Date() },
      }).run()
    }
  })
}

export const refreshPrices = async (
  db: Db,
  opts: { fetchImpl?: typeof fetch; today?: string } = {},
): Promise<{ ok: number; failed: number }> => {
  const to = opts.today ?? today()
  const from = to
  let ok = 0
  let failed = 0

  for (const instrument of db.select().from(instruments).all()) {
    if (instrument.priceSource === 'manual') continue
    const source = sourceFor(instrument.priceSource)
    try {
      const points = await source.fetch({
        sourceKey: instrument.sourceKey, from, to, fetchImpl: opts.fetchImpl,
      })
      writePrices(db, instrument.id, source.id, points)
      db.insert(priceFetchLog).values({
        source: source.id, instrumentId: instrument.id, runAt: new Date(), ok: true,
        message: `${points.length} hintapistettä`,
      }).run()
      ok++
    } catch (cause) {
      failed++
      db.insert(priceFetchLog).values({
        source: source.id, instrumentId: instrument.id, runAt: new Date(), ok: false,
        message: cause instanceof Error ? cause.message : 'Tuntematon virhe',
      }).run()
    }
  }
  return { ok, failed }
}

/** Fetch history back to the instrument's earliest transaction. */
export const backfillInstrument = async (
  db: Db,
  instrumentId: number,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<{ inserted: number }> => {
  const instrument = db.select().from(instruments).where(eq(instruments.id, instrumentId)).get()
  if (!instrument || instrument.priceSource === 'manual') return { inserted: 0 }

  const earliest = db.select({ tradeDate: transactions.tradeDate }).from(transactions)
    .where(eq(transactions.instrumentId, instrumentId))
    .orderBy(asc(transactions.tradeDate)).limit(1).get()
  if (!earliest) return { inserted: 0 }

  const points = await sourceFor(instrument.priceSource).fetch({
    sourceKey: instrument.sourceKey, from: earliest.tradeDate, to: today(),
    fetchImpl: opts.fetchImpl,
  })
  writePrices(db, instrumentId, instrument.priceSource, points)
  return { inserted: points.length }
}

/**
 * Weekday evenings, after Finnish fund NAVs publish. Bun.cron never overlaps runs:
 * the next fire is scheduled only once the handler settles.
 */
export const startScheduler = (db: Db) =>
  Bun.cron('30 19 * * 1-5', async () => {
    const { refreshFxRates } = await import('../fx')
    try {
      await refreshFxRates(db)
    } catch (cause) {
      console.error('FX refresh failed', cause)
    }
    const result = await refreshPrices(db)
    console.log(`Hintapäivitys: ${result.ok} onnistui, ${result.failed} epäonnistui`)
  }, { tz: 'Europe/Helsinki' })
```

Wire it into `src/server/index.ts`, after the `Bun.serve` call:

```ts
import { openDb } from './db'
import { startScheduler } from './prices/refresh'

const { db } = openDb()
if (Bun.env.NODE_ENV === 'production') startScheduler(db)

process.on('unhandledRejection', (cause) => console.error('Unhandled rejection', cause))
```

The `unhandledRejection` listener matters: `Bun.cron` mirrors `setTimeout` error semantics, so a
rejected handler with no listener exits the process with code 1. The job reschedules itself after
an error, so one failed evening does not stop the next.

- [ ] **Step 6: Run the tests**

Run: `bun test src/server/fx.test.ts src/server/prices/refresh.test.ts` → all PASS.

Verify the schedule parses before trusting it:

```bash
bun -e 'console.log(Bun.cron.parse("30 19 * * 1-5", { tz: "Europe/Helsinki" }))'
```

Then `bun run check`.

- [ ] **Step 7: Commit**

```bash
git add src/server/fx.ts src/server/fixtures src/server/prices/refresh.ts src/server/index.ts
git commit -m "feat: ecb fx ingestion, isolated daily price refresh and bun.cron scheduler"
```

---

### Task 16: Valuation API — DB rows into `core`, out as JSON

**Files:**
- Create: `src/server/valuation.ts`, `src/server/api/portfolio.ts`
- Modify: `src/server/index.ts`
- Test: `src/server/valuation.test.ts`

**Interfaces:**
- Consumes: every `core` module (Tasks 2–6), `openDb`/`testDb` (Task 7), `requireUser` (Task 8)
- Produces:
  - `loadPortfolio(db, userId: string): { txns: Txn[]; instruments: Instrument[]; prices: PriceLookup }`
  - `portfolioRoutes` — `GET /api/holdings`, `/api/value-series`, `/api/allocation`, `/api/returns`

This is the only module that translates between storage integers and `core`'s `Money`/`Quantity`.
`core` never sees a database row; the API never sees a bigint — every response serialises money as
a decimal string (`"1234.56"`), never as a JSON number, so no float ever touches the wire.

- [ ] **Step 1: Write the failing tests**

`src/server/valuation.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { testDb } from './db'
import { accounts, instruments, prices, transactions, user } from './db/schema'
import { loadPortfolio, holdingsFor } from './valuation'
import { formatMoney } from '../core/money'

const seed = () => {
  const { db } = testDb()
  db.insert(user).values({
    id: 'u1', name: 'T', email: 't@e.fi', emailVerified: true,
    createdAt: new Date(), updatedAt: new Date(),
  }).run()
  db.insert(user).values({
    id: 'u2', name: 'M', email: 'm@e.fi', emailVerified: true,
    createdAt: new Date(), updatedAt: new Date(),
  }).run()
  const mine = db.insert(accounts).values({
    userId: 'u1', name: 'Nordnet', broker: 'nordnet', baseCurrency: 'EUR',
  }).returning().get()
  const theirs = db.insert(accounts).values({
    userId: 'u2', name: 'Toisen tili', broker: 'op', baseCurrency: 'EUR',
  }).returning().get()
  const nokia = db.insert(instruments).values({
    isin: 'FI0009000681', ticker: 'NOKIA.HE', name: 'Nokia', kind: 'stock',
    currency: 'EUR', priceSource: 'yahoo', sourceKey: 'NOKIA.HE',
  }).returning().get()

  const buy = (accountId: number, hash: string) => db.insert(transactions).values({
    accountId, instrumentId: nokia.id, type: 'BUY', tradeDate: '2025-01-10',
    quantity: 100_000_000, unitPrice: 415, amount: -41800, fee: 300, tax: 0,
    currency: 'EUR', fxRateEur: 100_000_000, contentHash: hash, externalId: null, importId: null,
  }).run()
  buy(mine.id, 'a')
  buy(theirs.id, 'b')

  db.insert(prices).values([
    { instrumentId: nokia.id, date: '2025-01-10', close: 415, currency: 'EUR', source: 'yahoo', fetchedAt: new Date() },
    { instrumentId: nokia.id, date: '2025-06-02', close: 460, currency: 'EUR', source: 'yahoo', fetchedAt: new Date() },
  ]).run()

  return { db, instrumentId: nokia.id }
}

test('loads only the requesting user rows', () => {
  const { db } = seed()
  expect(loadPortfolio(db, 'u1').txns).toHaveLength(1)
  expect(loadPortfolio(db, 'u2').txns).toHaveLength(1)
  expect(loadPortfolio(db, 'nobody').txns).toHaveLength(0)
})

test('price lookup carries the latest price on or before a date', () => {
  const { db, instrumentId } = seed()
  const { prices: lookup } = loadPortfolio(db, 'u1')
  expect(formatMoney(lookup.priceOn(instrumentId, '2025-03-01')!)).toBe('4.15')
  expect(formatMoney(lookup.priceOn(instrumentId, '2025-07-01')!)).toBe('4.60')
  expect(lookup.priceOn(instrumentId, '2024-12-31')).toBeNull()
})

test('price lookup reports the date a price is actually dated', () => {
  const { db, instrumentId } = seed()
  const { prices: lookup } = loadPortfolio(db, 'u1')
  expect(lookup.priceDateOn(instrumentId, '2025-06-02')).toBe('2025-06-02')
  expect(lookup.priceDateOn(instrumentId, '2025-07-01')).toBe('2025-06-02')
})

test('holdings carry quantity, cost, value, gain and staleness as strings', () => {
  const { db } = seed()
  const holdings = holdingsFor(db, 'u1', '2025-07-01')
  expect(holdings).toHaveLength(1)
  const nokia = holdings[0]!
  expect(nokia.name).toBe('Nokia')
  expect(nokia.quantity).toBe('100.000000')
  expect(nokia.costEur).toBe('418.00')       // 415.00 + 3.00 fee
  expect(nokia.valueEur).toBe('460.00')
  expect(nokia.unrealisedEur).toBe('42.00')
  expect(nokia.priceDate).toBe('2025-06-02')
  expect(nokia.stale).toBe(true)
})

test('holdings are empty for a user with no accounts', () => {
  const { db } = seed()
  expect(holdingsFor(db, 'nobody', '2025-07-01')).toEqual([])
})
```

- [ ] **Step 2: Run and watch them fail**

Run: `bun test src/server/valuation.test.ts` → FAIL, `./valuation` missing.

- [ ] **Step 3: Implement the loader**

`src/server/valuation.ts`:

```ts
import { asc, eq, inArray } from 'drizzle-orm'
import type { openDb } from './db'
import { accounts, instruments, prices, fxRates, transactions } from './db/schema'
import type { PriceLookup } from '../core/returns'
import type { Instrument, IsoDate, Txn } from '../core/types'
import { costBasisAt } from '../core/costbasis'
import { positionsAt } from '../core/ledger'
import {
  formatMoney, formatQuantity, mulMoney, subMoney, toEur, zeroMoney,
  type Currency, type FxRate, type Money,
} from '../core/money'

type Db = ReturnType<typeof openDb>['db']

const asMoney = (minor: number, currency: Currency): Money => ({ minor: BigInt(minor), currency })
const asRate = (scaled: number, currency: Currency): FxRate => ({ scaled: BigInt(scaled), currency })

export const loadPortfolio = (
  db: Db,
  userId: string,
): { txns: Txn[]; instruments: Instrument[]; prices: PriceLookup } => {
  const ownedAccounts = db.select({ id: accounts.id }).from(accounts)
    .where(eq(accounts.userId, userId)).all().map((a) => a.id)

  const rows = ownedAccounts.length === 0 ? [] : db.select().from(transactions)
    .where(inArray(transactions.accountId, ownedAccounts))
    .orderBy(asc(transactions.tradeDate), asc(transactions.id)).all()

  const txns: Txn[] = rows.map((r) => ({
    id: r.id,
    accountId: r.accountId,
    instrumentId: r.instrumentId,
    type: r.type,
    tradeDate: r.tradeDate,
    quantity: { scaled: BigInt(r.quantity) },
    unitPrice: r.unitPrice === null ? null : asMoney(r.unitPrice, r.currency),
    amount: asMoney(r.amount, r.currency),
    fee: asMoney(r.fee, r.currency),
    tax: asMoney(r.tax, r.currency),
    currency: r.currency,
    fxRateEur: asRate(r.fxRateEur, r.currency),
  }))

  const instrumentRows = db.select().from(instruments).all()
  const priceRows = db.select().from(prices).orderBy(asc(prices.date)).all()
  const fxRows = db.select().from(fxRates).orderBy(asc(fxRates.date)).all()

  const byInstrument = new Map<number, typeof priceRows>()
  for (const row of priceRows) {
    const list = byInstrument.get(row.instrumentId) ?? []
    list.push(row)
    byInstrument.set(row.instrumentId, list)
  }

  /** Last row with `date <= on`, or null. Rows are pre-sorted ascending. */
  const latestOnOrBefore = <T extends { date: string }>(list: readonly T[] | undefined, on: string): T | null => {
    if (!list) return null
    let found: T | null = null
    for (const row of list) {
      if (row.date > on) break
      found = row
    }
    return found
  }

  const priceLookup: PriceLookup = {
    priceOn: (instrumentId, date) => {
      const row = latestOnOrBefore(byInstrument.get(instrumentId), date)
      return row ? asMoney(row.close, row.currency) : null
    },
    priceDateOn: (instrumentId, date) =>
      latestOnOrBefore(byInstrument.get(instrumentId), date)?.date ?? null,
    fxOn: (currency, date) => {
      if (currency === 'EUR') return asRate(100_000_000, 'EUR')
      const row = latestOnOrBefore(fxRows.filter((f) => f.currency === currency), date)
      return row ? asRate(row.rateEur, currency) : null
    },
  }

  return { txns, instruments: instrumentRows, prices: priceLookup }
}

export type HoldingView = {
  readonly instrumentId: number
  readonly isin: string
  readonly name: string
  readonly kind: Instrument['kind']
  readonly currency: Currency
  readonly quantity: string
  readonly costEur: string
  readonly valueEur: string
  readonly unrealisedEur: string
  readonly priceDate: string | null
  readonly stale: boolean
}

export const holdingsFor = (db: Db, userId: string, on: IsoDate): HoldingView[] => {
  const { txns, instruments: all, prices: lookup } = loadPortfolio(db, userId)
  const byId = new Map(all.map((i) => [i.id, i]))
  const costs = costBasisAt(txns, on)

  return [...positionsAt(txns, on)].flatMap(([instrumentId, quantity]) => {
    const instrument = byId.get(instrumentId)
    if (!instrument) return []
    const price = lookup.priceOn(instrumentId, on)
    const priceDate = lookup.priceDateOn(instrumentId, on)
    const rate = instrument.currency === 'EUR' ? null : lookup.fxOn(instrument.currency, on)

    const valueEur = price === null || (instrument.currency !== 'EUR' && rate === null)
      ? zeroMoney('EUR')
      : rate === null ? mulMoney(price, quantity) : toEur(mulMoney(price, quantity), rate)
    const costEur = costs.get(instrumentId) ?? zeroMoney('EUR')

    return [{
      instrumentId,
      isin: instrument.isin,
      name: instrument.name,
      kind: instrument.kind,
      currency: instrument.currency,
      quantity: formatQuantity(quantity),
      costEur: formatMoney(costEur),
      valueEur: formatMoney(valueEur),
      unrealisedEur: formatMoney(subMoney(valueEur, costEur)),
      priceDate,
      stale: priceDate !== on,
    }]
  }).sort((a, b) => Number(b.valueEur) - Number(a.valueEur))
}
```

- [ ] **Step 4: Implement the routes**

`src/server/api/portfolio.ts`:

```ts
import { z } from 'zod'
import { openDb } from '../db'
import { requireUser } from '../auth-guard'
import { handle, json } from '../http'
import { holdingsFor, loadPortfolio } from '../valuation'
import { allocateBy } from '../../core/allocation'
import { externalCashFlows } from '../../core/ledger'
import { formatMoney, parseMoney } from '../../core/money'
import { twr, valueSeries, xirr } from '../../core/returns'

const { db } = openDb()
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const today = (): string => new Date().toISOString().slice(0, 10)

const range = (url: URL) => ({
  from: IsoDate.parse(url.searchParams.get('from') ?? '2015-01-01'),
  to: IsoDate.parse(url.searchParams.get('to') ?? today()),
})

export const portfolioRoutes = {
  '/api/holdings': handle(async (request) => {
    const { userId } = await requireUser(request)
    const on = IsoDate.parse(new URL(request.url).searchParams.get('on') ?? today())
    return json(holdingsFor(db, userId, on))
  }),

  '/api/value-series': handle(async (request) => {
    const { userId } = await requireUser(request)
    const { from, to } = range(new URL(request.url))
    const { txns, instruments, prices } = loadPortfolio(db, userId)
    return json(valueSeries(txns, instruments, prices, from, to)
      .map((p) => ({ date: p.date, valueEur: formatMoney(p.valueEur), stale: p.stale })))
  }),

  '/api/allocation': handle(async (request) => {
    const { userId } = await requireUser(request)
    const url = new URL(request.url)
    const dimension = z.enum(['kind', 'currency', 'account', 'instrument'])
      .parse(url.searchParams.get('by') ?? 'kind')
    const on = IsoDate.parse(url.searchParams.get('on') ?? today())
    const { txns, instruments, prices } = loadPortfolio(db, userId)
    return json(allocateBy(txns, instruments, prices, on, dimension)
      .map((s) => ({ key: s.key, label: s.label, valueEur: formatMoney(s.valueEur), weight: s.weight })))
  }),

  '/api/returns': handle(async (request) => {
    const { userId } = await requireUser(request)
    const { from, to } = range(new URL(request.url))
    const { txns, instruments, prices } = loadPortfolio(db, userId)
    const series = valueSeries(txns, instruments, prices, from, to)
    const flows = externalCashFlows(txns).filter((f) => f.date >= from && f.date <= to)
    const final = series.at(-1)

    let mwr: number | null = null
    try {
      mwr = final
        ? xirr(
            flows.map((f) => ({ date: f.date, amountEur: parseMoney(`-${formatMoney(f.amountEur)}`, 'EUR') })),
            { date: final.date, amountEur: final.valueEur },
          )
        : null
    } catch {
      mwr = null   // not enough sign variety yet; the UI shows "—", not a wrong number
    }

    return json({
      from, to,
      valueEur: final ? formatMoney(final.valueEur) : '0.00',
      stale: final?.stale ?? false,
      twr: twr(series, flows),
      mwr,
    })
  }),
}
```

Register `...portfolioRoutes` in `src/server/index.ts`.

The `catch` that sets `mwr = null` is the one place a swallowed error is correct, and only
because the alternative is showing a fabricated rate. The UI renders `—` for it.

- [ ] **Step 5: Run the tests**

Run: `bun test src/server/valuation.test.ts` → PASS. Then `bun run check`.

- [ ] **Step 6: Commit**

```bash
git add src/server/valuation.ts src/server/valuation.test.ts src/server/api/portfolio.ts src/server/index.ts
git commit -m "feat: portfolio valuation api serving holdings, series, allocation and returns"
```

---

### Task 17: SPA shell, Finnish formatting and login

**Files:**
- Create: `src/web/index.html`, `src/web/main.tsx`, `src/web/styles.css`, `src/web/lib/format.ts`, `src/web/lib/api.ts`, `src/web/lib/auth-client.ts`, `src/web/routes/login.tsx`, `src/web/routes/root.tsx`
- Modify: `src/server/index.ts` (restore the `/*` HTML route commented out in Task 9)
- Test: `src/web/lib/format.test.ts`

**Interfaces:**
- Consumes: the API from Tasks 9, 12, 13, 16; Better Auth from Task 8
- Produces:
  - `eur(value: string): string`, `qty(value: string): string`, `pct(value: number): string`, `fiDate(iso: string): string`
  - `apiGet<T>(path: string): Promise<T>`, `apiPost<T>(path: string, body: unknown): Promise<T>`, `apiUpload<T>(path: string, form: FormData): Promise<T>`
  - `authClient` with `signIn`, `signOut`, `useSession`
  - `router` — TanStack Router instance with routes `/`, `/holdings`, `/imports`, `/login`

Money arrives from the API as decimal strings and is formatted, never parsed into arithmetic. The
frontend does no money maths at all.

- [ ] **Step 1: Write the failing tests**

`src/web/lib/format.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { eur, qty, pct, fiDate } from './format'

// fi-FI uses a comma decimal separator and a narrow no-break space for thousands.
const normalise = (s: string) => s.replace(/ | /g, ' ')

test('formats euro amounts in Finnish locale', () => {
  expect(normalise(eur('1234.56'))).toBe('1 234,56 €')
  expect(normalise(eur('-7.00'))).toBe('-7,00 €')
  expect(normalise(eur('0.00'))).toBe('0,00 €')
})

test('formats large amounts with grouping', () => {
  expect(normalise(eur('1234567.89'))).toBe('1 234 567,89 €')
})

test('trims trailing zeros from quantities but keeps meaningful decimals', () => {
  expect(normalise(qty('100.000000'))).toBe('100')
  expect(normalise(qty('12.345600'))).toBe('12,3456')
})

test('formats percentages from a decimal ratio', () => {
  expect(normalise(pct(0.0734))).toBe('+7,34 %')
  expect(normalise(pct(-0.12))).toBe('-12,00 %')
  expect(normalise(pct(0))).toBe('0,00 %')
})

test('formats ISO dates the Finnish way', () => {
  expect(fiDate('2025-06-02')).toBe('2.6.2025')
})
```

- [ ] **Step 2: Run and watch them fail**

Run: `bun test src/web/lib/format.test.ts` → FAIL, `./format` missing.

- [ ] **Step 3: Implement formatting**

`src/web/lib/format.ts`:

```ts
const EUR = new Intl.NumberFormat('fi-FI', {
  style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2,
})
const QTY = new Intl.NumberFormat('fi-FI', { minimumFractionDigits: 0, maximumFractionDigits: 6 })
const PCT = new Intl.NumberFormat('fi-FI', {
  style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 2,
})

/** Formats a decimal string from the API. Never used for arithmetic. */
export const eur = (value: string): string => EUR.format(Number(value))
export const qty = (value: string): string => QTY.format(Number(value))
export const pct = (ratio: number): string =>
  `${ratio > 0 ? '+' : ''}${PCT.format(ratio)}`
export const fiDate = (iso: string): string => {
  const [year, month, day] = iso.split('-')
  return `${Number(day)}.${Number(month)}.${year}`
}
```

`Number(value)` here is safe and deliberate: the string has already been rounded to two decimals
server-side, and this value is only ever displayed.

- [ ] **Step 4: Implement the API and auth clients**

`src/web/lib/api.ts`:

```ts
export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'ApiError'
  }
}

const unwrap = async (response: Response): Promise<unknown> => {
  const body = await response.json().catch(() => ({ error: 'Vastausta ei voitu lukea' }))
  if (!response.ok) {
    const message = typeof body === 'object' && body !== null && 'error' in body
      ? String((body as { error: unknown }).error)
      : `Virhe ${response.status}`
    throw new ApiError(response.status, message)
  }
  return body
}

export const apiGet = async <T>(path: string): Promise<T> =>
  (await unwrap(await fetch(path, { credentials: 'include' }))) as T

export const apiPost = async <T>(path: string, body: unknown): Promise<T> =>
  (await unwrap(await fetch(path, {
    method: 'POST', credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))) as T

export const apiUpload = async <T>(path: string, form: FormData): Promise<T> =>
  (await unwrap(await fetch(path, { method: 'POST', credentials: 'include', body: form }))) as T
```

The three `as T` casts are the boundary between untyped JSON and typed code. `anti-slop`'s
`require-safety-comment-for-type-assertion` applies — add a comment on each naming the invariant
(the route's response shape), or, better, thread a Zod schema through `apiGet` and parse instead
of asserting. Prefer the schema: it removes the assertion entirely and matches the project's
"validate at every boundary" rule.

`src/web/lib/auth-client.ts`:

```ts
import { createAuthClient } from 'better-auth/react'

export const authClient = createAuthClient({ baseURL: window.location.origin })
export const { signIn, signOut, useSession } = authClient
```

- [ ] **Step 5: Implement the shell**

`src/web/index.html`:

```html
<!doctype html>
<html lang="fi">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>PromptFolio</title>
    <link rel="stylesheet" href="./styles.css" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

`src/web/routes/root.tsx` — layout with navigation and the session gate:

```tsx
import { Link, Outlet, useNavigate } from '@tanstack/react-router'
import { useEffect } from 'react'
import { signOut, useSession } from '../lib/auth-client'

export const RootLayout = () => {
  const { data: session, isPending } = useSession()
  const navigate = useNavigate()

  useEffect(() => {
    if (!isPending && !session) void navigate({ to: '/login' })
  }, [isPending, session, navigate])

  if (isPending) return <main className="grid min-h-dvh place-items-center">Ladataan…</main>
  if (!session) return null

  return (
    <>
      <header className="flex items-center gap-6 border-b border-line bg-surface px-5 py-3">
        <span className="font-semibold tracking-tight">PromptFolio</span>
        <nav className="mr-auto flex gap-4">
          <Link to="/" className="text-muted no-underline hover:text-ink">Yleiskuva</Link>
          <Link to="/holdings" className="text-muted no-underline hover:text-ink">Omistukset</Link>
          <Link to="/imports" className="text-muted no-underline hover:text-ink">Tuonnit</Link>
        </nav>
        <button type="button" onClick={() => void signOut()}>Kirjaudu ulos</button>
      </header>
      <main className="mx-auto max-w-5xl px-5 pb-16 pt-8"><Outlet /></main>
    </>
  )
}
```

`src/web/routes/login.tsx`:

```tsx
import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { signIn } from '../lib/auth-client'

export const LoginPage = () => {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    const { error: failure } = await signIn.email({ email, password })
    setBusy(false)
    if (failure) { setError('Kirjautuminen epäonnistui'); return }
    void navigate({ to: '/' })
  }

  return (
    <main className="grid min-h-dvh place-items-center">
      <form className="card w-80" onSubmit={submit}>
        <h1>PromptFolio</h1>
        <label>Sähköposti
          <input type="email" value={email} autoComplete="username" required
                 onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>Salasana
          <input type="password" value={password} autoComplete="current-password" required
                 onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <p role="alert" className="text-loss text-sm">{error}</p>}
        <button type="submit" disabled={busy} className="w-full">
          {busy ? 'Kirjaudutaan…' : 'Kirjaudu'}
        </button>
      </form>
    </main>
  )
}
```

The error message is deliberately non-specific — it must not reveal whether the address exists.

`src/web/main.tsx`:

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createRootRoute, createRoute, createRouter, RouterProvider,
} from '@tanstack/react-router'
import { RootLayout } from './routes/root'
import { LoginPage } from './routes/login'
import { DashboardPage } from './routes/dashboard'
import { HoldingsPage } from './routes/holdings'
import { ImportsPage } from './routes/imports'

const rootRoute = createRootRoute({ component: RootLayout })
const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: '/', component: DashboardPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/holdings', component: HoldingsPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/imports', component: ImportsPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/login', component: LoginPage }),
])

const router = createRouter({ routeTree })
declare module '@tanstack/react-router' {
  interface Register { router: typeof router }
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 60_000, retry: 1 } },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
)
```

Tasks 18–20 create `dashboard.tsx`, `holdings.tsx` and `imports.tsx`. Stub each as
`export const XPage = () => <p>Tulossa</p>` now so the router compiles, and replace them in turn.

`src/web/styles.css` — the Tailwind entry point. Design tokens go in `@theme` so they become real
utilities (`bg-surface`, `text-muted`, `text-gain`), and only genuinely repeated compositions get
an `@utility`:

```css
@import "tailwindcss";

@theme {
  --color-bg: #fbfaf8;
  --color-surface: #ffffff;
  --color-ink: #14171a;
  --color-muted: #5c6670;
  --color-line: #e3e0da;
  --color-gain: #1f7a3f;
  --color-loss: #b3261e;
  --color-accent: #14484f;

  --font-sans: "Inter", ui-sans-serif, system-ui, sans-serif;
  --font-mono: "IBM Plex Mono", ui-monospace, "SF Mono", monospace;

  --radius-card: 0.625rem;
}

@layer base {
  html { color-scheme: light dark; }
  body { @apply bg-bg text-ink font-sans antialiased; }
  h1 { @apply text-2xl font-semibold tracking-tight mb-6; }
  h2 { @apply text-lg font-medium mb-4; }
  label { @apply grid gap-1 text-sm text-muted mb-3; }
  input, select {
    @apply bg-surface text-ink border border-line rounded-md px-3 py-2 text-base;
  }
  button {
    @apply bg-accent text-white rounded-md px-4 py-2 font-medium
           disabled:opacity-40 disabled:cursor-not-allowed;
  }
  table { @apply w-full border-collapse; }
  th { @apply text-left text-sm font-medium text-muted px-3 py-2 border-b border-line; }
  td { @apply px-3 py-2 border-b border-line; }
}

/* Every figure is tabular and right-aligned so columns of money line up. */
@utility num {
  @apply font-mono tabular-nums text-right;
}

@utility card {
  @apply bg-surface border border-line rounded-[--radius-card] p-5;
}

/* Undoes the base button styling for sort headers inside a table. */
@utility header-button {
  @apply bg-transparent text-inherit p-0 font-medium;
}
```

Dark mode comes from the same tokens. Add a `@media (prefers-color-scheme: dark)` block that
redefines the `--color-*` variables on `:root`; every utility built from them follows
automatically, and no component needs a `dark:` variant.

Sorting-header buttons inside `<th>` need `@apply bg-transparent text-inherit p-0 font-medium` to
undo the base `button` styling — do that with a `header-button` utility rather than repeating it.

- [ ] **Step 6: Restore the HTML route and run it**

Uncomment the `import index from '../web/index.html'` line and the `'/*': index` route in
`src/server/index.ts`.

Run `bun run dev`, open `http://localhost:3000`. You should be redirected to `/login`.

Create the first user once:

```bash
ALLOW_SIGNUP=true bun run dev
# then, in another terminal:
curl -X POST localhost:3000/api/auth/sign-up/email \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"a-long-passphrase","name":"Nimi"}'
```

Restart without `ALLOW_SIGNUP` and confirm a second sign-up attempt is refused.

- [ ] **Step 7: Run tests and commit**

Run: `bun test src/web` → PASS. Then `bun run check`.

```bash
git add src/web src/server/index.ts
git commit -m "feat: spa shell with tanstack router, better auth login and fi-fi formatting"
```

---

### Task 18: Chart wrappers and the dashboard

**Files:**
- Create: `src/web/charts/TimeSeriesChart.tsx`, `src/web/charts/AllocationChart.tsx`, `src/web/charts/palette.ts`, `src/web/routes/dashboard.tsx`
- Test: `src/web/charts/palette.test.ts`

**Interfaces:**
- Consumes: `apiGet` (Task 17), the endpoints from Task 16
- Produces:
  - `<TimeSeriesChart points={{ date: string; value: number }[]} label={string} />`
  - `<AllocationChart slices={{ label: string; value: number; weight: number }[]} />`
  - `SERIES_COLOURS: readonly string[]`, `colourFor(index: number): string`
  - `DashboardPage`

All `@tanstack/react-charts` usage lives in these two files and nowhere else. The library is
pre-1.0; when it breaks or gets replaced, this directory is the whole blast radius.

- [ ] **Step 1: Write the failing test**

`src/web/charts/palette.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { SERIES_COLOURS, colourFor } from './palette'

test('the palette has enough distinct colours for a realistic portfolio', () => {
  expect(SERIES_COLOURS.length).toBeGreaterThanOrEqual(8)
  expect(new Set(SERIES_COLOURS).size).toBe(SERIES_COLOURS.length)
})

test('colours cycle rather than running off the end', () => {
  expect(colourFor(0)).toBe(SERIES_COLOURS[0])
  expect(colourFor(SERIES_COLOURS.length)).toBe(SERIES_COLOURS[0])
  expect(colourFor(SERIES_COLOURS.length + 3)).toBe(SERIES_COLOURS[3])
})

test('every colour is a hex value', () => {
  for (const colour of SERIES_COLOURS) expect(colour).toMatch(/^#[0-9a-f]{6}$/i)
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `bun test src/web/charts/palette.test.ts` → FAIL, `./palette` missing.

- [ ] **Step 3: Implement the palette**

`src/web/charts/palette.ts`:

```ts
/** Ordered so adjacent slices stay distinguishable, and readable on both themes. */
export const SERIES_COLOURS = [
  '#14484f', '#c77d3a', '#4a7c59', '#8a5a83',
  '#2f6690', '#a8562f', '#5c7a3a', '#6b5b95',
] as const

export const colourFor = (index: number): string =>
  SERIES_COLOURS[index % SERIES_COLOURS.length]!
```

- [ ] **Step 4: Implement the chart wrappers**

`src/web/charts/TimeSeriesChart.tsx`:

```tsx
import { useMemo } from 'react'
import { Chart } from '@tanstack/react-charts'
import { colourFor } from './palette'

export type SeriesPoint = { date: string; value: number }

export const TimeSeriesChart = ({ points, label }: { points: SeriesPoint[]; label: string }) => {
  const data = useMemo(
    () => [{ label, data: points.map((p) => ({ primary: new Date(p.date), secondary: p.value })) }],
    [points, label],
  )
  const primaryAxis = useMemo(() => ({ getValue: (d: { primary: Date }) => d.primary }), [])
  const secondaryAxes = useMemo(
    () => [{ getValue: (d: { secondary: number }) => d.secondary, elementType: 'area' as const }],
    [],
  )

  if (points.length === 0) return <p className="text-muted">Ei vielä dataa.</p>

  return (
    <div className="h-80">
      <Chart options={{
        data, primaryAxis, secondaryAxes,
        getSeriesStyle: () => ({ fill: colourFor(0), stroke: colourFor(0) }),
        tooltip: { align: 'auto' },
      }} />
    </div>
  )
}
```

`src/web/charts/AllocationChart.tsx`:

```tsx
import { colourFor } from './palette'
import { eur } from '../lib/format'

export type AllocationSlice = { label: string; value: string; weight: number }

/**
 * A stacked proportion bar plus a legend. Deliberately not a pie: with 3-8 holdings
 * a bar compares lengths, which people read far more accurately than angles.
 */
export const AllocationChart = ({ slices }: { slices: AllocationSlice[] }) => {
  if (slices.length === 0) return <p className="text-muted">Ei omistuksia.</p>

  return (
    <div>
      <div className="flex h-3.5 overflow-hidden rounded-full">
        {slices.map((slice, index) => (
          <div key={slice.label}
               title={`${slice.label} ${(slice.weight * 100).toFixed(1)} %`}
               // width and colour are data-driven, so these two stay inline
               style={{ width: `${slice.weight * 100}%`, background: colourFor(index) }} />
        ))}
      </div>
      <ul className="mt-4 grid list-none gap-1.5 p-0">
        {slices.map((slice, index) => (
          <li key={slice.label} className="flex items-center gap-2.5">
            <span className="size-2.5 flex-none rounded-sm" style={{ background: colourFor(index) }} />
            <span className="flex-1">{slice.label}</span>
            <span className="num">{eur(slice.value)}</span>
            <span className="num w-18 text-muted">
              {(slice.weight * 100).toFixed(1)} %
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
```

- [ ] **Step 5: Implement the dashboard**

`src/web/routes/dashboard.tsx`:

```tsx
import { useQuery } from '@tanstack/react-query'
import { apiGet } from '../lib/api'
import { eur, pct, fiDate } from '../lib/format'
import { TimeSeriesChart } from '../charts/TimeSeriesChart'
import { AllocationChart, type AllocationSlice } from '../charts/AllocationChart'

type ValuePoint = { date: string; valueEur: string; stale: boolean }
type Returns = { valueEur: string; stale: boolean; twr: number; mwr: number | null; from: string; to: string }

const Stat = ({ label, value, tone }: { label: string; value: string; tone?: 'gain' | 'loss' }) => (
  <div className="card">
    <div className="text-sm text-muted">{label}</div>
    <div className={`font-mono tabular-nums text-2xl ${
      tone === 'gain' ? 'text-gain' : tone === 'loss' ? 'text-loss' : ''}`}>{value}</div>
  </div>
)

export const DashboardPage = () => {
  const series = useQuery({
    queryKey: ['value-series'],
    queryFn: () => apiGet<ValuePoint[]>('/api/value-series'),
  })
  const returns = useQuery({
    queryKey: ['returns'],
    queryFn: () => apiGet<Returns>('/api/returns'),
  })
  const allocation = useQuery({
    queryKey: ['allocation', 'kind'],
    queryFn: () => apiGet<AllocationSlice[]>('/api/allocation?by=kind'),
  })

  if (series.isError || returns.isError || allocation.isError) {
    return <p role="alert" className="text-loss">Tietojen haku epäonnistui. Yritä päivittää sivu.</p>
  }
  if (series.isPending || returns.isPending || allocation.isPending) return <p>Ladataan…</p>

  const staleFrom = series.data.filter((p) => p.stale).at(-1)

  return (
    <>
      <h1>Yleiskuva</h1>

      {staleFrom && (
        <p className="mb-4 inline-block rounded-full border border-line px-3 py-1 text-xs text-muted">
          Osa arvoista on vanhentuneita. Tuorein hinta: {fiDate(staleFrom.date)}.
        </p>
      )}

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Stat label="Salkun arvo" value={eur(returns.data.valueEur)} />
        <Stat label="Tuotto (aikapainotettu)" value={pct(returns.data.twr)}
              tone={returns.data.twr >= 0 ? 'gain' : 'loss'} />
        <Stat label="Oma tuotto (XIRR)"
              value={returns.data.mwr === null ? '—' : pct(returns.data.mwr)}
              tone={returns.data.mwr === null ? undefined : returns.data.mwr >= 0 ? 'gain' : 'loss'} />
      </section>

      <section className="card mt-6">
        <h2>Arvon kehitys</h2>
        <TimeSeriesChart label="Salkun arvo"
                         points={series.data.map((p) => ({ date: p.date, value: Number(p.valueEur) }))} />
      </section>

      <section className="card mt-6">
        <h2>Jakauma</h2>
        <AllocationChart slices={allocation.data} />
      </section>
    </>
  )
}
```

Two deliberate choices worth keeping: the stale badge is shown before the numbers, not hidden in a
tooltip, and XIRR renders `—` when the server could not compute it rather than `0 %`.

- [ ] **Step 6: Run and check**

Run: `bun test src/web/charts/palette.test.ts` → PASS. Run `bun run dev`, log in, and confirm the
dashboard renders with an empty portfolio (zeroes and "Ei vielä dataa", no crash).

If `@tanstack/react-charts@0.16` does not accept the `options` shape above, its API has moved:
adjust `TimeSeriesChart.tsx` only. If it cannot be made to work in an hour, replace that one file
with an inline `<svg>` line chart — the wrapper exists exactly so that choice stays local.

Then `bun run check`.

- [ ] **Step 7: Commit**

```bash
git add src/web/charts src/web/routes/dashboard.tsx
git commit -m "feat: dashboard with value series, returns and allocation"
```

---

### Task 19: Holdings table

**Files:**
- Create: `src/web/routes/holdings.tsx`
- Test: `src/web/routes/holdings.test.ts`

**Interfaces:**
- Consumes: `apiGet`, formatters (Task 17), `GET /api/holdings` (Task 16)
- Produces: `HoldingsPage`, `sortHoldings(rows, key, direction)`

TanStack Table drives sorting and grouping. The sort comparator is extracted as a pure function so
it can be tested without rendering.

- [ ] **Step 1: Write the failing test**

`src/web/routes/holdings.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { sortHoldings, type Holding } from './holdings'

const row = (name: string, valueEur: string, unrealisedEur: string): Holding => ({
  instrumentId: 1, isin: 'FI0000000000', name, kind: 'stock', currency: 'EUR',
  quantity: '1.000000', costEur: '100.00', valueEur, unrealisedEur,
  priceDate: '2025-06-02', stale: false,
})

test('sorts by value descending by default', () => {
  const rows = [row('A', '100.00', '0.00'), row('B', '500.00', '0.00'), row('C', '250.00', '0.00')]
  expect(sortHoldings(rows, 'valueEur', 'desc').map((r) => r.name)).toEqual(['B', 'C', 'A'])
})

test('sorts numerically, not lexically', () => {
  const rows = [row('A', '9.00', '0.00'), row('B', '100.00', '0.00')]
  expect(sortHoldings(rows, 'valueEur', 'desc').map((r) => r.name)).toEqual(['B', 'A'])
})

test('handles negative unrealised gains', () => {
  const rows = [row('A', '1.00', '-50.00'), row('B', '1.00', '10.00')]
  expect(sortHoldings(rows, 'unrealisedEur', 'asc').map((r) => r.name)).toEqual(['A', 'B'])
})

test('sorts names with Finnish collation', () => {
  const rows = [row('Ähtäri Oyj', '1.00', '0.00'), row('Aalto Oyj', '1.00', '0.00')]
  expect(sortHoldings(rows, 'name', 'asc').map((r) => r.name)).toEqual(['Aalto Oyj', 'Ähtäri Oyj'])
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `bun test src/web/routes/holdings.test.ts` → FAIL, module missing.

- [ ] **Step 3: Implement**

`src/web/routes/holdings.tsx`:

```tsx
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiGet } from '../lib/api'
import { eur, qty, fiDate } from '../lib/format'

export type Holding = {
  instrumentId: number
  isin: string
  name: string
  kind: 'stock' | 'etf' | 'fund' | 'cash'
  currency: 'EUR' | 'USD'
  quantity: string
  costEur: string
  valueEur: string
  unrealisedEur: string
  priceDate: string | null
  stale: boolean
}

type SortKey = 'name' | 'quantity' | 'costEur' | 'valueEur' | 'unrealisedEur'

const collator = new Intl.Collator('fi-FI')

export const sortHoldings = (
  rows: readonly Holding[],
  key: SortKey,
  direction: 'asc' | 'desc',
): Holding[] => {
  const sign = direction === 'asc' ? 1 : -1
  return rows.slice().sort((a, b) =>
    sign * (key === 'name'
      ? collator.compare(a.name, b.name)
      : Number(a[key]) - Number(b[key])))
}

const KIND_LABELS: Record<Holding['kind'], string> = {
  stock: 'Osake', etf: 'ETF', fund: 'Rahasto', cash: 'Käteinen',
}

export const HoldingsPage = () => {
  const [sortKey, setSortKey] = useState<SortKey>('valueEur')
  const [direction, setDirection] = useState<'asc' | 'desc'>('desc')

  const holdings = useQuery({
    queryKey: ['holdings'],
    queryFn: () => apiGet<Holding[]>('/api/holdings'),
  })

  const rows = useMemo(
    () => (holdings.data ? sortHoldings(holdings.data, sortKey, direction) : []),
    [holdings.data, sortKey, direction],
  )

  const toggle = (key: SortKey) => {
    if (key === sortKey) setDirection(direction === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setDirection(key === 'name' ? 'asc' : 'desc') }
  }

  if (holdings.isError) {
    return <p role="alert" className="text-loss">Omistusten haku epäonnistui.</p>
  }
  if (holdings.isPending) return <p>Ladataan…</p>
  if (rows.length === 0) {
    return (
      <>
        <h1>Omistukset</h1>
        <p className="text-muted">Ei omistuksia. Aloita tuomalla CSV-tiedosto Tuonnit-sivulta.</p>
      </>
    )
  }

  const header = (key: SortKey, label: string, numeric = true) => (
    <th className={numeric ? 'num' : undefined}>
      <button type="button" className="header-button" onClick={() => toggle(key)}
              aria-sort={sortKey === key ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}>
        {label}{sortKey === key ? (direction === 'asc' ? ' ↑' : ' ↓') : ''}
      </button>
    </th>
  )

  return (
    <>
      <h1>Omistukset</h1>
      <table>
        <thead>
          <tr>
            {header('name', 'Arvopaperi', false)}
            <th>Laji</th>
            {header('quantity', 'Määrä')}
            {header('costEur', 'Hankintameno')}
            {header('valueEur', 'Markkina-arvo')}
            {header('unrealisedEur', 'Tuotto')}
            <th>Hinta</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.instrumentId}>
              <td>
                {row.name}
                <div className="text-xs text-muted">{row.isin}</div>
              </td>
              <td>{KIND_LABELS[row.kind]}</td>
              <td className="num">{qty(row.quantity)}</td>
              <td className="num">{eur(row.costEur)}</td>
              <td className="num">{eur(row.valueEur)}</td>
              <td className={`num ${Number(row.unrealisedEur) >= 0 ? 'text-gain' : 'text-loss'}`}>
                {eur(row.unrealisedEur)}
              </td>
              <td className="num">
                {row.priceDate ? fiDate(row.priceDate) : '—'}
                {row.stale && (
                  <span className="ml-2 rounded-full border border-line px-2 py-0.5 text-xs text-muted">
                    vanha
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}
```

The empty state names the next action rather than saying "no data" — this is the first screen a
new user sees.

- [ ] **Step 4: Run and commit**

Run: `bun test src/web/routes/holdings.test.ts` → PASS. Then `bun run check`.

```bash
git add src/web/routes/holdings.tsx src/web/routes/holdings.test.ts
git commit -m "feat: sortable holdings table with cost, value, gain and staleness"
```

---

### Task 20: Imports screen — upload, review, commit, undo

**Files:**
- Create: `src/web/routes/imports.tsx`, `src/web/routes/UnknownInstrumentForm.tsx`
- Test: `src/web/routes/imports.test.ts`

**Interfaces:**
- Consumes: `apiUpload`, `apiPost`, `apiGet` (Task 17); `/api/imports/*` (Task 12); `/api/instruments` (Task 9)
- Produces: `ImportsPage`, `summarise(draft): { good: number; problems: number; unknown: number; canCommit: boolean }`

The screen enforces the pipeline's central rule visually: **Commit is disabled until every unknown
ISIN is resolved.** Problems are shown but do not block — the user chooses to proceed without
those rows.

- [ ] **Step 1: Write the failing test**

`src/web/routes/imports.test.ts`:

```ts
import { test, expect } from 'bun:test'
import { summarise, type DraftResponse } from './imports'

// Test rows carry only the fields `summarise` reads; a typed factory keeps the
// assertion out of the tests (anti-slop/require-safety-comment-for-type-assertion).
const txnStub = (line: number): DraftResponse['txns'][number] => ({
  line, type: 'BUY', tradeDate: '2025-01-10', isin: null,
  quantity: 0, amount: 0, currency: 'EUR',
})

const draft = (over: Partial<DraftResponse> = {}): DraftResponse => ({
  broker: 'nordnet', filename: 'x.csv', sha256: 'abc',
  txns: [], problems: [], unknownIsins: [], ...over,
})

test('counts rows, problems and unknown instruments', () => {
  const summary = summarise(draft({
    txns: [txnStub(2), txnStub(3)],
    problems: [{ line: 4, message: 'x', raw: {} }],
    unknownIsins: [{ isin: 'IE00B4L5Y983', name: 'IWDA' }],
  }))
  expect(summary).toMatchObject({ good: 2, problems: 1, unknown: 1 })
})

test('cannot commit while an isin is unresolved', () => {
  expect(summarise(draft({
    txns: [txnStub(2)],
    unknownIsins: [{ isin: 'IE00B4L5Y983', name: 'IWDA' }],
  })).canCommit).toBe(false)
})

test('can commit with problems present but no unknown isins', () => {
  expect(summarise(draft({
    txns: [txnStub(2)],
    problems: [{ line: 4, message: 'x', raw: {} }],
  })).canCommit).toBe(true)
})

test('cannot commit an empty draft', () => {
  expect(summarise(draft()).canCommit).toBe(false)
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `bun test src/web/routes/imports.test.ts` → FAIL, module missing.

- [ ] **Step 3: Implement the unknown-instrument form**

`src/web/routes/UnknownInstrumentForm.tsx`:

```tsx
import { useState } from 'react'
import { apiPost, ApiError } from '../lib/api'

const SOURCES = [
  { id: 'yahoo', label: 'Yahoo (pörssinoteeratut)' },
  { id: 'nordnet_fund', label: 'Nordnet-rahasto' },
  { id: 'op_fund', label: 'OP-rahasto' },
  { id: 'spankki_fund', label: 'S-Pankki-rahasto' },
  { id: 'danske_fund', label: 'Danske-rahasto' },
  { id: 'manual', label: 'Syötän arvon itse' },
] as const

export const UnknownInstrumentForm = (
  { isin, name, onResolved }: { isin: string; name: string; onResolved: () => void },
) => {
  const [kind, setKind] = useState<'stock' | 'etf' | 'fund'>('fund')
  const [currency, setCurrency] = useState<'EUR' | 'USD'>('EUR')
  const [priceSource, setPriceSource] = useState<string>('yahoo')
  const [sourceKey, setSourceKey] = useState('')
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)
    try {
      await apiPost('/api/instruments', {
        isin, name, kind, currency, priceSource, sourceKey,
        ticker: priceSource === 'yahoo' ? sourceKey : null,
      })
      onResolved()
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Tallennus epäonnistui')
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <strong>{name || isin}</strong>
      <div className="mb-3 font-mono text-xs text-muted">{isin}</div>
      <label>Laji
        <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
          <option value="stock">Osake</option>
          <option value="etf">ETF</option>
          <option value="fund">Rahasto</option>
        </select>
      </label>
      <label>Valuutta
        <select value={currency} onChange={(e) => setCurrency(e.target.value as typeof currency)}>
          <option value="EUR">EUR</option>
          <option value="USD">USD</option>
        </select>
      </label>
      <label>Hintalähde
        <select value={priceSource} onChange={(e) => setPriceSource(e.target.value)}>
          {SOURCES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
      </label>
      <label>Lähdetunnus
        <input value={sourceKey} required onChange={(e) => setSourceKey(e.target.value)}
               placeholder={priceSource === 'yahoo' ? 'esim. NOKIA.HE' : 'rahaston tunnus'} />
      </label>
      {error && <p role="alert" className="text-loss text-sm">{error}</p>}
      <button type="submit">Tallenna arvopaperi</button>
    </form>
  )
}
```

- [ ] **Step 4: Implement the imports screen**

`src/web/routes/imports.tsx`:

```tsx
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, apiGet, apiUpload } from '../lib/api'
import { eur, fiDate } from '../lib/format'
import { UnknownInstrumentForm } from './UnknownInstrumentForm'

export type DraftResponse = {
  broker: string
  filename: string
  sha256: string
  txns: Array<{
    line: number; type: string; tradeDate: string; isin: string | null
    quantity: number; amount: number; currency: string
  }>
  problems: Array<{ line: number; message: string; raw: Record<string, string> }>
  unknownIsins: Array<{ isin: string; name: string }>
}

type Account = { id: number; name: string; broker: string }

export const summarise = (draft: DraftResponse) => ({
  good: draft.txns.length,
  problems: draft.problems.length,
  unknown: draft.unknownIsins.length,
  canCommit: draft.txns.length > 0 && draft.unknownIsins.length === 0,
})

const minorToString = (minor: number): string => (minor / 100).toFixed(2)

export const ImportsPage = () => {
  const queryClient = useQueryClient()
  const [file, setFile] = useState<File | null>(null)
  const [accountId, setAccountId] = useState<number | null>(null)
  const [draft, setDraft] = useState<DraftResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)

  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => apiGet<Account[]>('/api/accounts') })

  const form = (): FormData => {
    const data = new FormData()
    data.set('file', file!)
    data.set('accountId', String(accountId))
    return data
  }

  const preview = useMutation({
    mutationFn: () => apiUpload<DraftResponse>('/api/imports/preview', form()),
    onSuccess: (data) => { setDraft(data); setError(null); setResult(null) },
    onError: (cause) => setError(cause instanceof ApiError ? cause.message : 'Esikatselu epäonnistui'),
  })

  const commit = useMutation({
    mutationFn: () => apiUpload<{ inserted: number; skipped: number }>('/api/imports/commit', form()),
    onSuccess: (data) => {
      setResult(`${data.inserted} tapahtumaa tuotu, ${data.skipped} ohitettu kaksoiskappaleena.`)
      setDraft(null)
      void queryClient.invalidateQueries()
    },
    onError: (cause) => setError(cause instanceof ApiError ? cause.message : 'Tuonti epäonnistui'),
  })

  const summary = draft ? summarise(draft) : null

  return (
    <>
      <h1>Tuonnit</h1>

      <section className="card">
        <label>Tili
          <select value={accountId ?? ''} onChange={(e) => setAccountId(Number(e.target.value))}>
            <option value="" disabled>Valitse tili</option>
            {(accounts.data ?? []).map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </label>
        <label>CSV-tiedosto
          <input type="file" accept=".csv,text/csv"
                 onChange={(e) => { setFile(e.target.files?.[0] ?? null); setDraft(null) }} />
        </label>
        <button type="button" disabled={!file || accountId === null || preview.isPending}
                onClick={() => preview.mutate()}>
          {preview.isPending ? 'Luetaan…' : 'Esikatsele'}
        </button>
      </section>

      {error && <p role="alert" className="mt-4 text-loss">{error}</p>}
      {result && <p role="status" className="mt-4 text-gain">{result}</p>}

      {draft && summary && (
        <>
          <section className="card mt-6">
            <h2>Esikatselu — {draft.broker}</h2>
            <p>
              {summary.good} tuotavaa riviä
              {summary.problems > 0 && `, ${summary.problems} ongelmaa`}
              {summary.unknown > 0 && `, ${summary.unknown} tuntematonta arvopaperia`}.
            </p>

            <table>
              <thead>
                <tr><th>Rivi</th><th>Päivä</th><th>Laji</th><th>ISIN</th><th className="num">Summa</th></tr>
              </thead>
              <tbody>
                {draft.txns.slice(0, 50).map((t) => (
                  <tr key={t.line}>
                    <td className="num">{t.line}</td>
                    <td>{fiDate(t.tradeDate)}</td>
                    <td>{t.type}</td>
                    <td>{t.isin ?? '—'}</td>
                    <td className="num">{eur(minorToString(t.amount))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {draft.txns.length > 50 && (
              <p className="mt-3 text-muted">…ja {draft.txns.length - 50} riviä lisää.</p>
            )}
          </section>

          {draft.problems.length > 0 && (
            <section className="card mt-4">
              <h2>Ongelmalliset rivit</h2>
              <p className="text-muted">Näitä rivejä ei tuoda. Korjaa tiedosto tai jatka ilman niitä.</p>
              <ul className="mt-3 grid gap-2">
                {draft.problems.map((p) => (
                  <li key={p.line}>
                    <strong>Rivi {p.line}:</strong> {p.message}
                    <div className="font-mono text-xs text-muted">
                      {Object.entries(p.raw).map(([k, v]) => `${k}=${v}`).join('  ')}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {draft.unknownIsins.length > 0 && (
            <section className="mt-4">
              <h2>Tuntemattomat arvopaperit</h2>
              <p className="text-muted">Lisää nämä ennen tuontia, jotta hinnat osataan hakea oikeasta lähteestä.</p>
              <div className="mt-3 grid gap-4 md:grid-cols-2">
                {draft.unknownIsins.map((u) => (
                  <UnknownInstrumentForm key={u.isin} isin={u.isin} name={u.name}
                                         onResolved={() => preview.mutate()} />
                ))}
              </div>
            </section>
          )}

          <button type="button" className="mt-6"
                  disabled={!summary.canCommit || commit.isPending}
                  onClick={() => commit.mutate()}>
            {commit.isPending ? 'Tuodaan…' : `Tuo ${summary.good} tapahtumaa`}
          </button>
        </>
      )}
    </>
  )
}
```

- [ ] **Step 5: Run and commit**

Run: `bun test src/web/routes/imports.test.ts` → PASS. Then `bun run check`.

Manually: create an account via `POST /api/accounts`, upload
`src/server/import/fixtures/nordnet-sample.csv`, resolve the IWDA ISIN in the form, commit, and
confirm the holdings page shows Nokia. Re-upload the same file and confirm every row is reported
as skipped.

```bash
git add src/web/routes/imports.tsx src/web/routes/UnknownInstrumentForm.tsx src/web/routes/imports.test.ts
git commit -m "feat: import screen with preview, problem list, isin resolution and commit gate"
```

---

### Task 21: End-to-end smoke test

**Files:**
- Create: `e2e/import-to-holdings.test.ts`
- Modify: `src/server/index.ts` (export a `createServer` factory so tests can start it on a random port)

**Interfaces:**
- Consumes: everything
- Produces: `createServer(opts: { port?: number; dbPath?: string })` — starts and returns a `Bun.Server`

One test covering the whole spine: sign up, create an account, import a CSV, read the holdings.
It exercises real HTTP against a real SQLite file, with no network beyond localhost.

- [ ] **Step 1: Refactor the entrypoint into a factory**

In `src/server/index.ts`, move the `Bun.serve` call into an exported function and keep the
top-level call behind an entry guard:

```ts
export const createServer = (opts: { port?: number } = {}) =>
  Bun.serve({
    port: opts.port ?? Number(Bun.env.PORT ?? 3000),
    development: Bun.env.NODE_ENV !== 'production',
    routes: { /* ... unchanged ... */ },
  })

if (import.meta.main) {
  const server = createServer()
  console.log(`PromptFolio kuuntelee osoitteessa ${server.url}`)
  if (Bun.env.NODE_ENV === 'production') startScheduler(openDb().db)
}
```

- [ ] **Step 2: Write the failing test**

`e2e/import-to-holdings.test.ts`:

```ts
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { unlinkSync } from 'node:fs'

const DB_PATH = `./data/e2e-${Bun.randomUUIDv7()}.db`
let server: ReturnType<typeof import('../src/server/index').createServer>
let base: string
let cookie = ''

beforeAll(async () => {
  Bun.env.DATABASE_PATH = DB_PATH
  Bun.env.ALLOW_SIGNUP = 'true'
  Bun.env.BETTER_AUTH_SECRET = `${crypto.randomUUID()}${crypto.randomUUID()}`
  const { openDb, migrate } = await import('../src/server/db')
  migrate(openDb(DB_PATH).db)
  const { createServer } = await import('../src/server/index')
  server = createServer({ port: 0 })
  base = server.url.origin
})

afterAll(() => {
  server.stop(true)
  for (const suffix of ['', '-wal', '-shm']) {
    try { unlinkSync(`${DB_PATH}${suffix}`) } catch { /* already gone */ }
  }
})

const call = async (path: string, init: RequestInit = {}): Promise<Response> => {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), cookie },
  })
  const setCookie = response.headers.get('set-cookie')
  if (setCookie) cookie = setCookie.split(';')[0]!
  return response
}

test('signs up, imports a csv, and reports holdings', async () => {
  const signup = await call('/api/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'e2e@example.com', password: 'pitkä-salasana-123', name: 'E2E' }),
  })
  expect(signup.status).toBeLessThan(400)

  const account = await (await call('/api/accounts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Nordnet', broker: 'nordnet', baseCurrency: 'EUR' }),
  })).json() as { id: number }
  expect(account.id).toBeGreaterThan(0)

  // Nokia must exist before the import; IWDA stays unknown and is expected in the draft.
  await call('/api/instruments', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      isin: 'FI0009000681', ticker: 'NOKIA.HE', name: 'Nokia', kind: 'stock',
      currency: 'EUR', priceSource: 'yahoo', sourceKey: 'NOKIA.HE',
    }),
  })
  await call('/api/instruments', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      isin: 'IE00B4L5Y983', ticker: 'IWDA.AS', name: 'iShares Core MSCI World', kind: 'etf',
      currency: 'USD', priceSource: 'yahoo', sourceKey: 'IWDA.AS',
    }),
  })

  const form = new FormData()
  form.set('accountId', String(account.id))
  form.set('file', new File(
    [await Bun.file('src/server/import/fixtures/nordnet-sample.csv').text()],
    'nordnet-sample.csv', { type: 'text/csv' },
  ))

  const preview = await (await call('/api/imports/preview', { method: 'POST', body: form })).json() as
    { txns: unknown[]; unknownIsins: unknown[] }
  expect(preview.unknownIsins).toEqual([])
  expect(preview.txns).toHaveLength(5)

  // The USD row needs an FX rate before it can commit.
  const { openDb } = await import('../src/server/db')
  const { fxRates } = await import('../src/server/db/schema')
  openDb(DB_PATH).db.insert(fxRates)
    .values({ date: '2025-05-02', currency: 'USD', rateEur: 92_000_000 }).run()

  const committed = await (await call('/api/imports/commit', {
    method: 'POST',
    body: (() => {
      const again = new FormData()
      again.set('accountId', String(account.id))
      again.set('file', form.get('file') as File)
      return again
    })(),
  })).json() as { inserted: number; skipped: number }
  expect(committed.inserted).toBe(5)

  const holdings = await (await call('/api/holdings')).json() as Array<{ isin: string; quantity: string }>
  const nokia = holdings.find((h) => h.isin === 'FI0009000681')
  expect(nokia?.quantity).toBe('60.000000')   // bought 100, sold 40
})
```

- [ ] **Step 3: Run it**

Run: `bun test e2e/` → PASS.

If the sign-up cookie is not carried, print `signup.headers.get('set-cookie')` and match the
cookie name Better Auth actually issues. If `holdings` is empty, the account scoping in
`loadPortfolio` is filtering by the wrong user — check the session user id.

- [ ] **Step 4: Commit**

```bash
git add e2e src/server/index.ts
git commit -m "test: end-to-end signup, csv import and holdings"
```

---

### Task 22: Deployment — Docker, environment, README

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `compose.yaml`, `.env.example`, `README.md`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: everything
- Produces: a container that runs migrations on start and serves the app on `PORT`

- [ ] **Step 1: Write the Dockerfile**

`Dockerfile`:

```dockerfile
FROM oven/bun:1.4 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1.4-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/src ./src
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/drizzle.config.ts ./drizzle.config.ts

RUN mkdir -p /data && chown -R bun:bun /data /app
USER bun
VOLUME ["/data"]
ENV DATABASE_PATH=/data/promptfolio.db
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD bun -e "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "src/server/index.ts"]
```

The healthcheck needs an endpoint. Add it to `src/server/index.ts` routes, above `'/*'`:

```ts
    '/api/health': () => Response.json({ ok: true }),
```

It must not require authentication and must not touch the database — a health check that queries
SQLite turns a slow query into a container restart loop.

`.dockerignore`:

```
node_modules
dist
data
.git
*.db
*.db-wal
*.db-shm
docs
e2e
```

- [ ] **Step 2: Run migrations at startup**

In `src/server/index.ts`, inside the `import.meta.main` guard and **before** `createServer()`:

```ts
  const { db } = openDb()
  migrate(db)
```

The container has no separate migration step; a fresh volume becomes a working database on first
boot. Migrations are additive and idempotent, so this is safe to run every start.

- [ ] **Step 3: Write compose and the env template**

`compose.yaml`:

```yaml
services:
  promptfolio:
    build: .
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      BASE_URL: ${BASE_URL:-http://localhost:3000}
      BETTER_AUTH_SECRET: ${BETTER_AUTH_SECRET:?set this in .env}
      TZ: Europe/Helsinki
    volumes:
      - promptfolio-data:/data

volumes:
  promptfolio-data:
```

`TZ` matters: `Bun.cron` is given `tz: 'Europe/Helsinki'` explicitly for the schedule, but log
timestamps and any `new Date()` formatting follow the container clock.

`.env.example`:

```
# Generate: bun -e 'console.log(crypto.randomUUID()+crypto.randomUUID())'
BETTER_AUTH_SECRET=replace-me-with-64-random-characters
BASE_URL=http://localhost:3000
DATABASE_PATH=./data/promptfolio.db
# Set to true only while creating a user, then remove.
# ALLOW_SIGNUP=true
```

- [ ] **Step 4: Write the README**

`README.md` — replace the stub. Cover, in this order: what it is; requirements (Bun 1.4 or
Docker); first run including generating the secret and creating the first user with
`ALLOW_SIGNUP`; how to export a CSV from Nordnet and OP and import it; what "stale" means on a
price; how to back up (`cp` the SQLite file, or `docker compose cp`); the scheduled refresh time
and how to trigger one by hand; and a "Phase 1 scope" section listing what is deliberately absent
(reconciliation, PDF and screenshot import, chat, tax, rebalancing) with a pointer to
`docs/superpowers/specs/2026-08-27-portfolio-manager-design.md`.

- [ ] **Step 5: Verify the container end to end**

```bash
echo "BETTER_AUTH_SECRET=$(bun -e 'console.log(crypto.randomUUID()+crypto.randomUUID())')" > .env
docker compose up --build -d
curl -fsS localhost:3000/api/health
docker compose logs --tail 20
```

Confirm: health returns `{"ok":true}`, the log shows the server URL, and `docker compose down &&
docker compose up -d` preserves data (the volume survives, holdings are still there).

- [ ] **Step 6: Commit**

```bash
git add Dockerfile .dockerignore compose.yaml .env.example README.md .gitignore src/server/index.ts
git commit -m "chore: containerise with migrate-on-boot, healthcheck and persistent volume"
```

---

## Phase 1 completion checklist

Run this before calling Phase 1 done. Every line must be verified, not assumed.

- [ ] `bun run check` passes: oxlint (anti-slop included), oxfmt, tsc, and the full test suite
- [ ] `bun test --coverage` reports ≥ 80% and the run does not fail the `coverageThreshold` gate
- [ ] The whole suite passes with networking disabled
- [ ] `bun test e2e/` passes
- [ ] `src/core/layering.test.ts` passes — no I/O has leaked into the pure layer
- [ ] A real Nordnet export and a real OP export both import correctly, with their fixtures committed (anonymised)
- [ ] Re-importing the same file inserts nothing and reports every row as skipped
- [ ] Undo removes an import, and is refused when a later sale depends on it
- [ ] A USD purchase shows the correct EUR cost basis at its historical rate
- [ ] Every held instrument has a working price source, or is `manual` and documented as such
- [ ] A deliberately broken price source degrades to a stale badge; the dashboard still renders
- [ ] TWR and XIRR both display, and XIRR shows `—` rather than a wrong number when it cannot converge
- [ ] Signing up is refused with `ALLOW_SIGNUP` unset
- [ ] A second user sees none of the first user's accounts, transactions, or holdings
- [ ] `docker compose up` from a clean volume produces a working instance
- [ ] Backup and restore of the SQLite file round-trips

## What Phase 1 does not include

Deferred by design, each getting its own spec: reconciliation UI, PDF import, screenshot/vision
import, AI chat, the Finnish tax module, and rebalancing analysis. See
`docs/superpowers/specs/2026-08-27-portfolio-manager-design.md` §2.

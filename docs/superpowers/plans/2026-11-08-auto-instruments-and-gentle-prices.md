# Self-adding instruments and gentle Yahoo use — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Imports add new instruments by themselves, listed holdings refresh every 15 minutes in market hours, and Yahoo is asked so rarely that it stops answering 429.

**Architecture:** Every Yahoo request goes through one D1-backed gate that pauses on a 429. Prices for many symbols come from one batch request. The import preview resolves unknown ISINs through a remembered lookup and the commit creates the instruments; anything the owner must decide still goes to the existing form.

**Tech Stack:** TypeScript, TanStack Start on Cloudflare Workers, D1 + drizzle-orm (migrations via `pnpm db:generate`), zod, vitest with injected `fetchImpl`.

**Spec:** `docs/superpowers/specs/2026-11-08-auto-instruments-and-gentle-prices-design.md`

## Global Constraints

- Tests never reach the network: every fetch is injected (`fetchImpl`), the global one throws (`src/server/test-network-guard.ts`).
- No getting around Yahoo's limits: no rotating or spoofed identities, no retry through a 429. A 429 means wait.
- Back-off after a 429: `Retry-After` when present, otherwise start 15 minutes, double per consecutive 429, cap 6 hours; a successful request resets it.
- Intraday cron `*/15 * * * 1-5`; the existing `0 18 * * 1-5` stays.
- Market hours (local, with time zone): Helsinki 10:00–18:30 `Europe/Helsinki`; Xetra 09:00–17:30 `Europe/Berlin`; Stockholm 09:00–17:30 `Europe/Stockholm`; NYSE/Nasdaq 09:30–16:00 `America/New_York`. Symbol suffix → exchange: `.HE` Helsinki, `.DE` Xetra, `.ST` Stockholm, no suffix US; any other suffix is treated as open during Xetra hours.
- "Nothing found" lookups are retried after 7 days; "found" is kept for good.
- Form cases (owner's decision): nothing found; only listing in another currency than the holding; a row without ISIN resolved by name search (OP funds resolved via their OP page are not a form case).
- Project style: Finnish UI copy, `ponytail:` comments for deliberate shortcuts, immutable updates, zod at boundaries, lint with `pnpm exec oxlint --type-aware`, format with `pnpm run fmt`.

## Review Focus

1. **Yahoo pauses in the middle of a preview** — the import must still go through, the paused ISINs becoming pending instruments, never "nothing found" (a swallowed pause currently reads as not-found: `settle()` in `lookup.ts`). Test in Task 3.
2. **The same unknown ISIN on many rows, or in two files** — one lookup, one instrument, no unique-index failure on `instruments.isin`. Test in Task 5.
3. **An OP fund paste row (no ISIN) whose ISIN is discovered** — the row must end up linked to the created instrument at commit. Test in Task 5.
4. **The owner edits an instrument while its lookup is pending** — the late lookup must not overwrite it. Test in Task 7.
5. **Daylight-saving and weekend edges in market hours** — 18:29 Helsinki in summer and winter is open, 18:31 is not, Saturday never. Test in Task 6.

---

### Task 1: Schema — gate, lookup cache, lookup status

**Files:**

- Modify: `src/server/db/schema.ts`
- Create: migration via `pnpm db:generate` (new folder under `drizzle/`)
- Test: `src/server/db/schema-lookups.test.ts`

**Interfaces:**

- Produces:
  - `instruments.lookupStatus: text("lookup_status", { enum: ["ok", "pending", "attention"] }).notNull().default("ok")`
  - table `yahoo_gate` (`yahooGate`): `id integer pk` (always 1), `pausedUntil integer` (epoch ms, nullable), `backoffMs integer notNull default 0`
  - table `instrument_lookups` (`instrumentLookups`): `key text pk` (the ISIN, or `name:` + lowercased name), `outcome text enum ["found","form","pending"] notNull`, `result text notNull` (JSON of `InstrumentLookup`), `checkedAt integer timestamp_ms notNull`

- [ ] **Step 1: Write a test** that inserts an instrument without `lookupStatus` and reads back `"ok"`, inserts and reads a `yahooGate` row, and upserts an `instrumentLookups` row twice on the same key leaving one row.
- [ ] **Step 2: Run it** — `pnpm exec vitest run src/server/db/schema-lookups.test.ts` — expect FAIL (no such column/table).
- [ ] **Step 3: Add the columns and tables** to `schema.ts`; run `pnpm db:generate`; check the generated `migration.sql` only adds (no table rebuild of `transactions`).
- [ ] **Step 4: Run** `pnpm db:migrate:local` and the test — expect PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(db): yahoo gate, lookup cache and instrument lookup status"`

### Task 2: The Yahoo gate

**Files:**

- Create: `src/server/prices/yahoo-gate.ts`
- Test: `src/server/prices/yahoo-gate.test.ts`

**Interfaces:**

- Consumes: `yahooGate` (Task 1)
- Produces:
  - `class YahooPausedError extends Error { readonly until: number }`
  - `gatedFetch(db: Db, fetchImpl: FetchImpl, now?: () => number): FetchImpl` — a fetch that throws `YahooPausedError` without a request while paused; on 429 stores the pause (`Retry-After` seconds or the doubling back-off, cap 6 h) and throws `YahooPausedError`; on any other response resets `backoffMs` to 0 and returns it.
  - `yahooPausedUntil(db: Db, now?: () => number): Promise<number | null>`

- [ ] **Step 1: Write tests:** `"a 429 pauses, and the next call makes no request"` (stub counts calls; second call rejects with `YahooPausedError`, call count stays 1); `"Retry-After is honoured"` (`Retry-After: 120` → `until === now + 120_000`); `"back-off doubles and caps at six hours"` (successive 429s after each pause expires → 15 min, 30 min, … , never above 21_600_000 ms); `"a success resets the back-off"`.
- [ ] **Step 2: Run** `pnpm exec vitest run src/server/prices/yahoo-gate.test.ts` — FAIL.
- [ ] **Step 3: Implement** in `yahoo-gate.ts`; the gate row is upserted at `id = 1`.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(prices): one gate for every Yahoo request, paused on a 429"`

### Task 3: Batch quotes, and a lookup that knows "paused" from "not found"

**Files:**

- Create: `src/server/prices/yahoo-batch.ts`
- Modify: `src/server/instruments/lookup.ts` (`settle`, `pickListing`, `lookupInstrument` result)
- Test: `src/server/prices/yahoo-batch.test.ts`, `src/server/instruments/lookup.test.ts`

**Interfaces:**

- Consumes: `YahooPausedError` (Task 2)
- Produces:
  - `fetchLatestQuotes(symbols: readonly string[], fetchImpl: FetchImpl): Promise<Map<string, FetchedPrice>>` — one request for all symbols (chunks of 20 if the endpoint caps); a symbol Yahoo does not know is simply absent from the map.
  - `InstrumentLookup` gains `outcome: "found" | "form" | "pending"` and `formReason: "nothing" | "currency" | "name" | null`.
  - `lookupInstrument(isin, name, currency, fetchImpl)` keeps its signature; it returns `outcome: "pending"` when a `YahooPausedError` was thrown anywhere inside (`settle` rethrows it, the top level catches it).

- [ ] **Step 1: Verify the endpoint once by hand** (one request, no headers added): `curl -s 'https://query1.finance.yahoo.com/v8/finance/spark?symbols=NOKIA.HE,KCR.HE&range=1d&interval=1d' | head -c 600`. If it returns prices per symbol, use it. If it needs a crumb or errors, implement `fetchLatestQuotes` as the existing chart call per symbol, sequential, `await` of 2 s between symbols (`// ponytail: spaced single requests; batch if Yahoo offers one`). Record which in the file's doc comment.
- [ ] **Step 2: Write tests:** `fetchLatestQuotes` — `"one request returns every symbol's latest close and currency"` (stub asserts it was called once with both symbols in the URL); `"an unknown symbol is absent, not an error"`. `lookupInstrument` — `"a 429 during the lookup is pending, not nothing-found"` (stub answers 429 through `gatedFetch` → `outcome: "pending"`); `"the only listing in another currency goes to the form"` (EUR holding, only a USD candidate → `outcome: "form"`, `formReason: "currency"`); `"a share found by name goes to the form"` (`isin: null`, not an OP fund → `formReason: "name"`); `"an OP fund found by its page is found, with its ISIN"`; `"candidate listings cost one request"` (stub counts quote requests: 1).
- [ ] **Step 3: Run** `pnpm exec vitest run src/server/prices/yahoo-batch.test.ts src/server/instruments/lookup.test.ts` — FAIL.
- [ ] **Step 4: Implement** `yahoo-batch.ts`; in `lookup.ts` make `settle` rethrow `YahooPausedError`, make `pickListing` use `fetchLatestQuotes(candidates)` and read each candidate's currency from the map, and set `outcome`/`formReason` as the tests state. Update existing lookup tests for the new fields.
- [ ] **Step 5: Run** — PASS; also `pnpm exec vitest run src/server/instruments`.
- [ ] **Step 6: Commit** — `git commit -m "feat(instruments): batch listing probes, and tell a paused Yahoo from nothing found"`

### Task 4: Remembered lookups

**Files:**

- Create: `src/server/instruments/lookup-cache.ts`
- Test: `src/server/instruments/lookup-cache.test.ts`

**Interfaces:**

- Consumes: `instrumentLookups` (Task 1), `lookupInstrument`, `InstrumentLookup` (Task 3), `gatedFetch` (Task 2)
- Produces:
  - `lookupKey(isin: string | null, name: string): string` — the ISIN, or `` `name:${name.trim().toLowerCase()}` ``
  - `rememberedLookup(db: Db, isin: string | null, name: string, currency: Currency | null, fetchImpl: FetchImpl, now?: () => number): Promise<InstrumentLookup>` — returns a cached `found` forever, a cached `form` younger than 7 days, otherwise looks up through `gatedFetch(db, fetchImpl)` and stores the answer; a `pending` answer is stored too but never served from the cache.

- [ ] **Step 1: Write tests:** `"a found lookup is asked once"` (two calls, stub hit once); `"nothing-found is asked again after a week"` (`now` advanced 7 days + 1 ms → second network lookup); `"a pending answer is retried at once"`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(instruments): remember each ISIN's lookup"`

### Task 5: Import adds instruments by itself

**Files:**

- Create: `src/server/instruments/auto-add.ts`
- Modify: `src/server/import/service.ts` (`buildDraft`, `buildPasteDraft`, `previewUpload`, `previewPaste`, `commitDraftBody`), `src/server/import/map.ts` (`Draft` type), `src/server/import/txn-draft.ts` (`DraftBody`)
- Test: `src/server/instruments/auto-add.test.ts`, `src/server/import/service.test.ts`

**Interfaces:**

- Consumes: `rememberedLookup`, `lookupKey` (Task 4), `addInstrument` (`src/server/instruments/store.ts`)
- Produces:
  - `Draft` gains `added: AddedInstrument[]` where `AddedInstrument = { isin: string; name: string; kind: InstrumentKind; currency: string; priceSource: "yahoo" | "op_fund" | null; sourceKey: string | null; pending: boolean }`.
  - `resolveUnknown(db: Db, draft: Draft, fetchImpl: FetchImpl): Promise<Draft>` — looks up each distinct `unknownIsins` entry once; `found` and `pending` with an ISIN move from `unknownIsins` to `added`; an OP fund row whose ISIN was discovered gets `txn.isin` filled; `form` stays in `unknownIsins`.
  - `createAdded(db: Db, draft: Draft): Promise<Draft>` — at commit, for each `added` entry reads its remembered lookup **from the cache, not from the client's draft**, creates the instrument (`pending` → `priceSource: "manual"`, `sourceKey: isin`, `lookupStatus: "pending"`, kind from OpenFIGI or `"stock"`; an ISIN already in `instruments` is reused, not re-added) and sets `instrumentId` on every txn with that ISIN.
  - Preview responses carry `added`; `commitDraftBody` runs `createAdded` before `commitDraft`.

- [ ] **Step 1: Write tests** in `auto-add.test.ts`: `"a found ISIN is listed as added and leaves unknownIsins"`; `"a form-case ISIN stays unknown"`; `"one ISIN on many rows is looked up once"`; `"an OP fund row gets its discovered ISIN"`; `createAdded`: `"creates each instrument once and links every row"`, `"an ISIN that already exists is reused"`, `"a pending one is created as manual with lookupStatus pending"`, `"values in the client draft are ignored in favour of the remembered lookup"` (draft says `sourceKey: "EVIL"`, cache says `NOKIA.HE` → stored `NOKIA.HE`).
- [ ] **Step 2: Add to `service.test.ts`:** `"a preview with a new ISIN commits without any form"` (reader stub + lookup stub; preview `unknownIsins` empty, `added` has it; commit inserts the rows linked to the new instrument); `"a preview while Yahoo is paused still commits, as pending"`.
- [ ] **Step 3: Run** `pnpm exec vitest run src/server/instruments/auto-add.test.ts src/server/import/service.test.ts` — FAIL.
- [ ] **Step 4: Implement**; preview stays free of instrument writes (only the lookup cache).
- [ ] **Step 5: Run** — PASS; then `pnpm exec vitest run src/server/import`.
- [ ] **Step 6: Commit** — `git commit -m "feat(import): add new instruments by themselves"`

### Task 6: Market hours and the 15-minute refresh

**Files:**

- Create: `src/server/prices/market-hours.ts`, `src/server/prices/intraday.ts`
- Modify: `src/server/prices/refresh.ts` (Yahoo instruments via `fetchLatestQuotes`, skip instruments nobody holds, gate every Yahoo call including `backfillInstrument`/`backfillMany`), `src/server/import/backfill-on-commit.ts` (through the gate; a paused gate leaves the backfill to the evening run)
- Test: `src/server/prices/market-hours.test.ts`, `src/server/prices/intraday.test.ts`, `src/server/prices/refresh.test.ts`

**Interfaces:**

- Consumes: `fetchLatestQuotes` (Task 3), `gatedFetch` (Task 2), `writePrices` (`src/server/prices/write.ts`)
- Produces:
  - `isOpen(symbol: string, at: Date): boolean`
  - `heldInstrumentIds(db: Db): Promise<Set<number>>` — instruments with a non-zero position in any account.
  - `refreshIntraday(db: Db, at: Date, fetchImpl?: FetchImpl): Promise<{ asked: number; written: number; paused: boolean }>` — one batch for held Yahoo instruments whose exchange is open; none open → no request.

- [ ] **Step 1: Write tests:** `isOpen` — `"Helsinki 18:29 local is open, 18:31 is not, in summer and in winter"` (`2026-07-01T15:29Z` open, `15:31Z` closed; `2026-01-15T16:29Z` open, `16:31Z` closed); `"Saturday is never open"`; `"a US symbol follows New York hours"`. `refreshIntraday` — `"asks once for every open, held listing"` (stub called once with both symbols); `"no open exchange, no request"`; `"an instrument nobody holds is not asked for"`; `"a paused gate makes no request and reports paused"`. `refresh.test.ts` — existing tests updated so Yahoo instruments are asked in one batch.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** `pnpm exec vitest run src/server/prices` — PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(prices): listed holdings every 15 minutes in market hours, in one request"`

### Task 7: Finishing pending lookups, and the schedule

**Files:**

- Create: `src/server/instruments/resolve-pending.ts`
- Modify: `src/server/instruments/store.ts` (`updateInstrument` sets `lookupStatus: "ok"`), `src/worker.ts`, `wrangler.jsonc`
- Test: `src/server/instruments/resolve-pending.test.ts`

**Interfaces:**

- Consumes: `rememberedLookup` (Task 4), `refreshIntraday` (Task 6), `runScheduledRefresh`
- Produces:
  - `resolvePending(db: Db, fetchImpl?: FetchImpl): Promise<{ resolved: number; attention: number }>` — for each `lookupStatus: "pending"` instrument: `found` → set source, code, currency, `lookupStatus: "ok"`; `form` → `lookupStatus: "attention"`; still paused → leave pending. Only rows still `pending` are written (`where lookup_status = 'pending'`), so a Muokkaa edit in between wins.
  - `worker.ts` `scheduled(event)`: `event.cron === "*/15 * * * 1-5"` → `refreshIntraday` then `resolvePending`; `"0 18 * * 1-5"` → `runScheduledRefresh` then `resolvePending`.

- [ ] **Step 1: Write tests:** `"a pending instrument gets its source once Yahoo answers"`; `"a pending one that lands in a form case is marked for attention"`; `"an instrument edited in Muokkaa while pending is left alone"` (`updateInstrument` first → status `ok` → `resolvePending` changes nothing).
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement**; add `"*/15 * * * 1-5"` to `triggers.crons` in `wrangler.jsonc`.
- [ ] **Step 4: Run** `pnpm exec vitest run src/server/instruments` — PASS; `pnpm exec tsc --noEmit` clean. Locally: `curl "http://localhost:3000/cdn-cgi/local/scheduled?cron=*/15+*+*+*+1-5"` and check the dev log shows one intraday run.
- [ ] **Step 5: Commit** — `git commit -m "feat(instruments): finish paused lookups on the schedule"`

### Task 8: Show what was chosen

**Files:**

- Modify: `src/server/valuation.ts` / holdings view (add `sourceKey`, `priceSource`, `lookupStatus` to each holding), `src/web/routes/holdings-sort.ts` (`Holding` type), `src/web/routes/holdings.tsx`, `src/web/routes/imports.tsx`, `src/web/routes/imports-draft.ts` (`added`)
- Test: `src/web/routes/holdings-label.test.ts`

**Interfaces:**

- Consumes: `Draft.added` (Task 5), `lookupStatus` (Task 1)
- Produces:
  - `instrumentLabel(h: { isin: string | null; sourceKey: string; priceSource: string; currency: string; lookupStatus: "ok" | "pending" | "attention" }): string` in `src/web/routes/holdings-label.ts`

- [ ] **Step 1: Write tests:** `instrumentLabel` — `"ISIN, ticker and currency"` → `"FI4000567029 · FIA1S.HE · EUR"`; `"a pending lookup says so"` → `"FI4000567029 · haetaan tunnusta · EUR"`; `"a manual price shows no code"` → `"FI4000233267 · oma hinta · EUR"`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** the helper; render it under each holding's name on Omistukset; for `attention` add a `text-loss` note "Hintalähdettä ei löytynyt" next to the existing Muokkaa button. In the import preview, above the transactions, list `added` as `Lisätään: {name} — {sourceKey ?? "haetaan tunnusta"} · {currency}`.
- [ ] **Step 4: Run** `pnpm exec vitest run src/web` and `pnpm exec tsc --noEmit` — PASS / clean.
- [ ] **Step 5: Commit** — `git commit -m "feat(web): show each holding's ticker and currency, and what an import added"`

### Task 9: Whole-suite check

- [ ] **Step 1:** `pnpm run fmt && pnpm exec tsc --noEmit && pnpm exec oxlint --type-aware && pnpm exec vitest run` — all clean, all pass.
- [ ] **Step 2:** Restart `pnpm run dev`, import a Nordnet CSV containing an ISIN not yet in the ledger, and confirm the preview lists it under "Lisätään" with no form, and Omistukset shows its ticker and currency after commit.

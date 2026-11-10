# Playwright End-to-End Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Browser tests that cover every page of PromptFolio and run fully in parallel, each Playwright worker against its own server and its own empty D1 database.

**Architecture:** No shared `webServer`. A worker-scoped fixture generates a throwaway wrangler config, migrates and seeds a fresh local D1 under `test-results/e2e/`, and starts `vite dev` on a free port. Each test signs up its own user, so tests inside one worker never see each other's rows. The Worker's outbound calls (Claude, Yahoo, ECB) are rerouted to a fake HTTP server owned by the same fixture, so no test touches the network.

**Tech Stack:** `@playwright/test` 1.65 (installed), `@cloudflare/vite-plugin` (`configPath`, `persistState`), `wrangler d1` CLI, Node `http`.

**Spec:** none. The owner's request is the authority: "Start writing Playwright tests for the app. Create a plan with good coverage of the features. Make it so that the tests can be run fully in parallel (separate dbs)". Rulings made without a spec are provisional.

## Proven by a spike (2026-11-10)

- `cloudflare({ configPath, persistState: { path } })` driven by `E2E_DIR` gives a server its own database; two servers ran side by side on ports 4801 and 4802, up in about 4 s each.
- `wrangler d1 migrations apply promptfolio --local -c <dir>/wrangler.jsonc --persist-to <dir>/state` migrates that database, and `wrangler d1 execute ... --command/--file` seeds it. Both must run before the server starts.
- Wrangler resolves `.env` and `.dev.vars` from the directory of the config file, so the owner's `.env` (real API key) is not loaded by a config that lives in `test-results/e2e/<n>/`.
- `POST /api/auth/sign-up/email` with an `origin` header equal to `BASE_URL` creates a user and sets the session cookie when `ALLOW_SIGNUP` is `"true"`.
- Replacing `globalThis.fetch` at module load in `src/worker.ts` reroutes outbound calls. Vite reloads the module, so an unguarded install wraps twice (the fake saw `/127.0.0.1:4899/example.invalid/probe`): the install must be idempotent.

## Found while building Task 1

- Parallel servers fought over the debugger port (9231 in use): `inspectorPort: false` under `E2E_DIR`.
- A click before React has attached does a plain form post and the action is lost: the harness `page.goto` waits for `networkidle`.
- Every broker file, the Nordnet CSV included, is read by a recipe Claude writes (`readBrokerTableByRecipe`), and the Dashboard asks Claude for the weekly summary on load. So almost every page test needs the fake Claude; `e2e/import-to-holdings.spec.ts` is `test.fixme` until Task 2.
- When Claude answers with an error the Imports page shows the raw upstream text (`400 {}`) in its alert. Not fixed here; reported to the owner.
- The seed holds instruments only, no prices: holdings are valued at cost, so no figure depends on the run date (Review Focus 5 no longer applies).
- `e2e/` is outside `tsconfig.json` `include`, so `tsc` does not check it; oxlint and oxfmt do.

## Global Constraints

- Never open, migrate, seed or delete anything under `.wrangler/` (the owner's real database). All e2e state lives under `test-results/e2e/`.
- No test may reach the real network. Every outbound call goes to the fake; a call the test did not script fails that test.
- Fake people and fake payees only. No real names, account numbers or amounts from the owner's ledger. Use the fixtures in `src/server/import/fixtures/`.
- Every test creates its own user through the `user` fixture and depends on no other test. `fullyParallel: true`; no `test.describe.serial`.
- Selectors: `getByRole` / `getByLabel` / `getByText`. No CSS class selectors, no `waitForTimeout`.
- An app bug found while writing a test: do not fix the app. Mark the test `test.fixme` with one line saying what is wrong and report it.
- These tests describe existing behaviour, so red-then-green does not apply; instead each new test must be seen to fail once (break one assertion, run, restore) before it is committed.
- No re-exports; import from the defining module. Immutability, small files (a spec per page, under 300 lines).
- `pnpm typecheck`, `pnpm lint`, `pnpm test` stay clean. Conventional commits.
- Before a commit: `pnpm e2e` green twice in a row.

## Review Focus

1. Cold Vite dependency cache with several servers starting at once (shared `node_modules/.vite`): servers must still come up. Task 1 pins this with a run of `--workers 4` after `rm -rf node_modules/.vite`; if it flakes, give each server `cacheDir: ${E2E_DIR}/vite`.
2. A worker restarted after a failed test: the old server and fake must be stopped and the new ones must get new ports and a new database (Task 1, teardown test by killing a test).
3. `E2E_UPSTREAM` set to a non-loopback URL in production must be ignored, not obeyed (Task 1 unit test).
4. A streamed chat turn that outlives its test must not leak a scripted reply into the next test of the same worker (Task 2: `claude` fixture resets the queue and fails on leftovers).
5. An outbound call no test scripted must fail that test, not pass silently (Task 2 adds the test Task 1 skipped).

---

### Task 1: Harness — one server and one database per worker

**Files:**

- Modify: `vite.config.ts` (read `E2E_DIR`), `playwright.config.ts`, `src/worker.ts`, `.env.example`, `e2e/import-to-holdings.spec.ts`
- Create: `src/server/upstream-override.ts`, `src/server/upstream-override.test.ts`, `e2e/harness/server.ts`, `e2e/harness/seed.ts`, `e2e/harness/upstream.ts`, `e2e/harness/test.ts`
- Delete: `e2e/seed.ts` (imports `cloudflare:workers` under Node; cannot run)

**Interfaces (produced):**

- `installUpstreamOverride(target: string | undefined): void` — no-op unless `target` is `http://127.0.0.1:<port>` or `http://localhost:<port>`; replaces `globalThis.fetch` once (marker on the function) with one that sends `https://host/path?q` to `${target}/host/path?q`, same method, headers and body. Called at module load in `src/worker.ts` with `env.E2E_UPSTREAM`.
- `startUpstream(): Promise<Upstream>` where `Upstream = { url: string; calls: readonly { host: string; path: string; body: string }[]; unexpected: readonly string[]; on(host: string, handler: (req: { path: string; body: string }) => Response | undefined): void; reset(): void; stop(): Promise<void> }`. A call no handler answers gets 502 and is pushed to `unexpected`.
- `startServer(upstreamUrl: string): Promise<{ baseURL: string; stop(): Promise<void> }>` — free port, dir `test-results/e2e/<port>/`, writes `wrangler.jsonc` (vars `BASE_URL`, `ALLOW_SIGNUP: "true"`, `BETTER_AUTH_SECRET`, `ANTHROPIC_API_KEY: "e2e-key"`, `CRON_SECRET: "e2e-cron"`, `E2E_UPSTREAM`; `main`, `migrations_dir`, `migrations_pattern` as paths back to the repo), migrates, executes `seedSql()`, spawns `pnpm exec vite dev --port <port> --strictPort` with `E2E_DIR`, resolves when `GET /login` is 200 (60 s limit, server log in the error).
- `seedSql(): string` — the four instruments of the Nordnet fixture (ISINs and names from the deleted `e2e/seed.ts`, `price_source` `manual`); no prices.
- `e2e/harness/test.ts` exports `test` and `expect`: worker fixtures `app: { baseURL; upstream }`; test fixtures `baseURL` (from `app`), `user: { name; email; password }` (signed up through `page.request.post("/api/auth/sign-up/email", …)` with a unique email, cookie lands in the context), `freshApp` (a server of its own, for first-run), and an auto fixture that calls `upstream.reset()` before and asserts `upstream.unexpected` is empty after each test.

- [ ] **Step 1:** Write `src/server/upstream-override.test.ts`: reroutes URL, method, headers, body; ignores `undefined`, `""`, `https://evil.example`, `http://10.0.0.1:1`; a second install does not wrap twice. Run: FAIL (module missing).
- [ ] **Step 2:** Implement `installUpstreamOverride`, call it in `src/worker.ts`, add `E2E_UPSTREAM=` with a comment to `.env.example`. `pnpm test src/server/upstream-override.test.ts`: PASS. `pnpm typecheck`: clean.
- [ ] **Step 3:** Write `e2e/harness/{upstream,seed,server,test}.ts`.
- [ ] **Step 4:** `playwright.config.ts`: `fullyParallel: true`, no `workers` cap locally (`workers: process.env.CI ? 2 : undefined`), no `webServer`, no `use.baseURL`, `timeout: 60_000`.
- [ ] **Step 5:** Move `e2e/import-to-holdings.spec.ts` onto the harness: the first-run sign-up form uses `freshApp`; delete `e2e/seed.ts`.
- [ ] **Step 6:** Add `e2e/harness.spec.ts` with three tests: two tests each add a debt with the same name and each sees exactly one row (same worker, different users); `app.upstream.unexpected` is non-empty after `POST /api/cron/refresh`-style unscripted traffic is forced (use `page.request` against a route that fetches, or skip if none exists without a held Yahoo instrument and say so).
- [ ] **Step 7:** `rm -rf node_modules/.vite && pnpm e2e --workers 4 --repeat-each 3`: all pass. Then `pnpm e2e` twice. Check `git status` shows nothing under `.wrangler` changed and `ls test-results/e2e` holds one directory per started server.
- [ ] **Step 8:** Commit `test(e2e): one server and one database per Playwright worker`.

### Task 2: Fake Claude and fake Yahoo

**Files:**

- Create: `src/server/chat/anthropic-stream-fixture.ts` (move `anthropicStream` out of `src/server/chat/runner.test.ts`, which then imports it), `e2e/harness/claude.ts`, `e2e/chat-smoke.spec.ts`
- Modify: `e2e/harness/test.ts`

**Interfaces:**

- Consumes: `Upstream.on`, `anthropicStream(text, tools?, stopReason?): Response`.
- Also: `claude.replyRecipe("nordnet")` queues the recipe JSON the vitest suite already uses to read `nordnet-sample.csv` (find it in `src/server/import/recipe/broker-table.test.ts` or `service.test.ts`; move it to a fixture module both import). The weekly-summary call on the Dashboard gets a default answer of HTTP 400 that does not count as unexpected, unless the test queued a reply for it (tell the calls apart by the system prompt). Un-`fixme` `e2e/import-to-holdings.spec.ts` in this task.
- Produces: test fixture `claude: { reply(text: string): void; replyWithTool(name: string, input: unknown): void; replyJson(value: unknown): void; requests: readonly { system: string; lastUser: string; model: string }[] }`. Replies are a queue served in order on `api.anthropic.com/v1/messages`; an empty queue answers 500 and counts as unexpected; a non-empty queue at test end fails the test. Yahoo hosts answer 404 unless a test registers a chart with `app.upstream.on`.

- [ ] **Step 1:** Move `anthropicStream`; `pnpm test src/server/chat`: PASS.
- [ ] **Step 2:** Write `e2e/harness/claude.ts` and the fixture.
- [ ] **Step 3:** `e2e/chat-smoke.spec.ts`: on `/chat` the user asks "Hello", `claude.reply("Hi from the fake.")`, the text appears; `claude.requests[0].system` contains "Finnish".
- [ ] **Step 4:** Close two gaps Task 1 left. (a) In `e2e/harness.spec.ts` add a test that proves the guard: with `test.fail()`, a signed-in user opens `/chat` and sends a message with nothing queued; the test must be reported as an expected failure because `upstream.unexpected` is not empty. (b) Prove a restarted worker gets a new server: run `pnpm e2e e2e/harness.spec.ts --workers 1` with one test temporarily made to fail first, confirm in `test-results/e2e/` that two port directories exist and no `vite dev --port` process of the run is left (`pgrep -fl "E2E\|vite dev --port"`; the owner's own dev server on port 3000 is not yours, never kill it). Restore the test. Report what you saw.
- [ ] **Step 5:** `pnpm e2e` twice; commit `test(e2e): scripted Claude and Yahoo stand-ins`.

## Tasks 3–9: one spec file per page

Every one of these tasks follows the same steps: read the page component in `src/web/routes/` and its view tests, add small helpers to `e2e/harness/flows.ts` when two specs need the same steps (`createBrokerAccount`, `importNordnet`, `createBankAccount`, `importOpCsv` using `src/server/import/fixtures/nordnet-sample.csv` and `op-bank-sample.csv`), write the spec, see each test fail once, run `pnpm e2e` twice, commit `test(e2e): <page>`.

They consume the harness from Tasks 1–2: `test`, `expect` from `e2e/harness/test.ts`; fixtures `user`, `app`, `freshApp`, `claude`.

### Task 3: Auth, smoke, isolation

**Files:**

- Create: `e2e/auth.spec.ts`, `e2e/smoke.spec.ts`, `e2e/isolation.spec.ts`
- Modify (if shared steps are needed): `e2e/harness/flows.ts`

**Scenarios (each its own test):**

- first-run form creates the owner and lands on `/` (`freshApp`)
- mismatched passwords refused
- logged out, `/holdings` redirects to `/login`
- wrong password shows an error
- sign out
- every nav link opens its heading with no console error and no failed request
- theme toggle survives reload
- user B sees none of user A's accounts, debts or chat

- [ ] **Step 1:** Read the page components and their view tests.
- [ ] **Step 2:** Write the spec files; see each test fail once by breaking one assertion, then restore.
- [ ] **Step 3:** `pnpm e2e` twice, `pnpm lint`, `pnpm fmt:check`; commit `test(e2e): auth, smoke, isolation`.

### Task 4: Imports, holdings, dashboard

**Files:**

- Create: `e2e/imports.spec.ts`, `e2e/holdings.spec.ts`, `e2e/dashboard.spec.ts`
- Modify (if shared steps are needed): `e2e/harness/flows.ts`

**Scenarios (each its own test):**

- Nordnet import "Import 12 transactions", re-import "0 transactions imported, 12 skipped as duplicates"
- history lists it
- undo empties Holdings
- an ISIN not seeded asks for the instrument and commits after it is filled in
- Holdings rows WisdomTree "€68.00" and Nordnet Suomi Indeksi "-5"
- record a price by hand changes the value
- rename/edit an instrument
- Dashboard empty state for a new user
- after import value stat, allocation and "Value over time" chart drawn
- range buttons change the chart

- [ ] **Step 1:** Read the page components and their view tests.
- [ ] **Step 2:** Write the spec files; see each test fail once by breaking one assertion, then restore.
- [ ] **Step 3:** `pnpm e2e` twice, `pnpm lint`, `pnpm fmt:check`; commit `test(e2e): imports, holdings, dashboard`.

### Task 5: Cash and spending

**Files:**

- Create: `e2e/cash.spec.ts`, `e2e/spending.spec.ts`
- Modify (if shared steps are needed): `e2e/harness/flows.ts`

**Scenarios (each its own test):**

- create a bank account
- import the OP CSV, balance shown
- manual entry add and remove
- rename account
- Spending totals by category
- a payee without a category gets a rule and moves
- month switch
- internal transfers are not spending

- [ ] **Step 1:** Read the page components and their view tests.
- [ ] **Step 2:** Write the spec files; see each test fail once by breaking one assertion, then restore.
- [ ] **Step 3:** `pnpm e2e` twice, `pnpm lint`, `pnpm fmt:check`; commit `test(e2e): cash and spending`.

### Task 6: Debts and reconcile

**Files:**

- Create: `e2e/debts.spec.ts`, `e2e/reconcile.spec.ts`
- Modify (if shared steps are needed): `e2e/harness/flows.ts`

**Scenarios (each its own test):**

- add student loan and credit card
- add balances, "Owed in total" follows the latest
- future date refused with "A balance cannot be dated in the future"
- remove balance and debt with the confirm dialog
- Dashboard shows "Net worth" and "Value over time (before debts)" only with a debt
- Reconcile: a pasted or typed holdings statement that matches shows no differences, one that differs names the instrument

- [ ] **Step 1:** Read the page components and their view tests.
- [ ] **Step 2:** Write the spec files; see each test fail once by breaking one assertion, then restore.
- [ ] **Step 3:** `pnpm e2e` twice, `pnpm lint`, `pnpm fmt:check`; commit `test(e2e): debts and reconcile`.

### Task 7: Rebalance, forecast, tax

**Files:**

- Create: `e2e/rebalance.spec.ts`, `e2e/forecast.spec.ts`, `e2e/tax.spec.ts`
- Modify (if shared steps are needed): `e2e/harness/flows.ts`

**Scenarios (each its own test):**

- set targets, drift shown, new-money split adds up to the amount typed
- monthly plan row add, change, remove
- horizon 1 to 20 years redraws
- real/nominal toggle
- Tax year with the fixture's sales shows both methods and the year switch

- [ ] **Step 1:** Read the page components and their view tests.
- [ ] **Step 2:** Write the spec files; see each test fail once by breaking one assertion, then restore.
- [ ] **Step 3:** `pnpm e2e` twice, `pnpm lint`, `pnpm fmt:check`; commit `test(e2e): rebalance, forecast, tax`.

### Task 8: Chat

**Files:**

- Create: `e2e/chat.spec.ts`
- Modify (if shared steps are needed): `e2e/harness/flows.ts`

**Scenarios (each its own test):**

- streamed answer
- tool call then answer (two queued replies), tool label shown
- proposal card Confirm writes the change and it is visible on its page, Decline writes nothing
- deletion card is warning-styled
- chart reply draws a chart
- docked assistant on `/holdings` sends the page name
- conversation list, reopen, delete
- Claude 500 shows an error and the composer works again

- [ ] **Step 1:** Read the page components and their view tests.
- [ ] **Step 2:** Write the spec files; see each test fail once by breaking one assertion, then restore.
- [ ] **Step 3:** `pnpm e2e` twice, `pnpm lint`, `pnpm fmt:check`; commit `test(e2e): chat`.

### Task 9: AI imports and weekly summary

**Files:**

- Create: `e2e/ai-imports.spec.ts`, `e2e/summary.spec.ts`
- Modify (if shared steps are needed): `e2e/harness/flows.ts`

**Scenarios (each its own test):**

- drop two files at once, fake sort reply places each on its account
- unknown kind left for the owner
- OP PDF statement import
- a new bank layout asks for a recipe (fake reply) and previews rows
- weekly summary shows the fake note
- a note with a number not in the facts is not shown

- [ ] **Step 1:** Read the page components and their view tests.
- [ ] **Step 2:** Write the spec files; see each test fail once by breaking one assertion, then restore.
- [ ] **Step 3:** `pnpm e2e` twice, `pnpm lint`, `pnpm fmt:check`; commit `test(e2e): ai imports and weekly summary`.

### Task 10: Docs and final proof

- [ ] README "Testing" gains `pnpm e2e` (what it starts, that it never touches the real database, `pnpm exec playwright install chromium` once).
- [ ] `pnpm e2e --repeat-each 3` green; `pnpm check` green; commit `docs: how to run the browser tests`.

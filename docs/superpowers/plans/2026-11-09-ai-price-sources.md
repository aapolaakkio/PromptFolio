# Price sources the AI finds — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Only OpenFIGI and Yahoo stay built in. Any other price page is found by Claude's web search and read by a verified, stored recipe. The OP and Nordnet readers are replaced, and their instruments move over.

**Architecture:** A page recipe is a model-written pattern set, run by the app against the raw page HTML. It is accepted only after the app checks identity, currency, date and plausibility. Recipes live in a `page_recipes` table, one row per instrument. The evening run reads pages with stored recipes and calls the model only when a recipe reads nothing. The lookup asks a web-search finder when OpenFIGI and Yahoo come up empty. The finder also replaces the OP slug discovery for rows with no ISIN.

**Tech Stack:** TypeScript, TanStack Start on Cloudflare Workers, D1 + drizzle-orm (`pnpm db:generate`, `pnpm db:migrate:local`), zod, vitest with injected `fetchImpl` and a scripted `ChatClient`.

**Spec:** `docs/superpowers/specs/2026-11-09-ai-price-sources-design.md`

## Global Constraints

- Built-in sources: OpenFIGI and Yahoo only. After Task 7, `PriceSourceId` is `"yahoo" | "page" | "manual"`.
- Tests never reach the network or a model:
  - every fetch is injected (`fetchImpl`), and the global one throws (`src/server/test-network-guard.ts`);
  - every model call goes through an injected `ChatClient` (`src/server/chat/runner.ts`).
- No getting around a site's limits:
  - plain GET, no cookies, no spoofed identity;
  - one request per page per evening run;
  - pages fetched one after another with `PAGE_SPACING_MS = 2000`.
- Recipe acceptance (all must hold), run by the app on the fetched page:
  - exactly one match;
  - the ISIN (or, with no ISIN, the name, case-insensitive) occurs within `IDENTITY_WINDOW_CHARS = 5000` characters of the match;
  - the currency equals the holding's;
  - the date is no more than `PAGE_MAX_AGE_DAYS = 10` days before today and not in the future;
  - the price is within `MAX_PLAUSIBLE_RATIO` (`src/server/prices/write.ts`) of a reference price, when one exists.
- Model calls:
  - model: `RECIPE_MODEL` from `src/server/import/recipe/ask.ts`;
  - recipes are asked through `askForRecipe`, which keeps its `MAX_ATTEMPTS`;
  - a page instrument is asked about again at most once per `PAGE_REASK_DAYS = 7`.
- Patterns pass `mayBacktrackForever` and `MAX_PATTERN_LENGTH` (`src/server/import/recipe/pattern-safety.ts`, `types.ts`).
- The model being down or throwing at import time gives the lookup outcome `"pending"`, never `"form"`.
- Finnish UI copy. `ponytail:` comments for deliberate shortcuts. Immutable updates. zod at boundaries.
- Lint with `pnpm exec oxlint --type-aware` and format with `pnpm run fmt`.
- Never use `git stash`.

## Review Focus

1. **A list page showing many funds' NAVs** (a sister-fund trap). The recipe matches more than once, or the ISIN is far from the match. It is refused. Test in Task 2.
2. **Finnish number and date forms.** `1 234,56` with a non-breaking space, and OP's date with no year (`31.12.` read on 2 January) resolving to the previous year. Test in Task 2.
3. **Model down during an import preview.** The import still goes through, and the instrument is created pending, as with a Yahoo pause. Test in Task 5.
4. **A page that changes or 404s.** One model ask, then `attention`. Later nights make no model call within 7 days, and a later good read clears `attention`. Test in Task 4.
5. **A moved OP or Nordnet fund whose new recipe can't be verified on the first run.** It goes to `attention`, keeps its stored prices, and is not deleted. Test in Task 7.

---

### Task 1: Schema — `page` source and recipe table

**Files:**

- Modify: `src/server/db/schema.ts`, `src/core/types.ts`
- Create: migration via `pnpm db:generate`
- Test: `src/server/db/schema-page.test.ts`

**Interfaces:**

- Produces:
  - `instruments.priceSource` enum gains `"page"` (old values stay until Task 7);
  - `PriceSourceId` gains `"page"`;
  - table `pageRecipes`, columns:
    - `instrumentId` (PK, FK `instruments.id`, on delete cascade);
    - `recipe` (text JSON, nullable: null while none is verified);
    - `askedAt` (integer ms, nullable).

- [ ] **Step 1: Write tests.**
  - `"a page instrument can be stored with its recipe"`: insert an instrument with `priceSource: "page"`, `sourceKey: "https://example.test/fund"`, and a `pageRecipes` row. Read both back.
  - `"deleting the instrument deletes its recipe"`.
- [ ] **Step 2: Run** `pnpm exec vitest run src/server/db/schema-page.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.** Make the schema change, then run `pnpm db:generate` and `pnpm db:migrate:local`.
- [ ] **Step 4: Run** the test and `pnpm exec tsc --noEmit`. Expect PASS and a clean typecheck. Exhaustive `Record<PriceSourceId, …>` sites (`registry.ts`) may need a placeholder entry. Use the `MANUAL` source with a `ponytail:` comment, since Task 4 replaces it.
- [ ] **Step 5: Commit** with `git commit -m "feat(db): page price source and page recipes"`.

### Task 2: Page recipe — format, runner, verification

**Files:**

- Create: `src/server/prices/page-recipe.ts`
- Test: `src/server/prices/page-recipe.test.ts`, which uses `src/server/prices/fixtures/{nordnet-fund-suomi,nordnet-fund-sverige,op-maailma-indeksi}.html`

**Interfaces:**

- Consumes: `MoneyFormatSchema`, `MAX_PATTERN_LENGTH` (`src/server/import/recipe/types.ts`); `mayBacktrackForever`; `parseMoney` (`src/core/money.ts`); `MAX_PLAUSIBLE_RATIO`; `Judged` (`ask.ts`).
- Produces:
  - `PageRecipeSchema` (zod), with `type PageRecipe = { kind: "page"; pattern: string; dateFormat: "d.m.yyyy" | "dd.mm.yyyy" | "yyyy-mm-dd" | "d.m." | "dd.mm."; money: MoneyFormat; currency: string | null }`.
    - `pattern` must name the groups `price` and `date`.
    - It may also name `currency`. The fixed `currency` is used when the group is absent.
  - `type PageRead = { matches: number; price: FetchedPrice | null; identityNear: boolean }`
  - `runPageRecipe(html: string, recipe: PageRecipe, identity: string, today: string): PageRead`
    - `identity` is the ISIN, or the name when there is none.
    - A date with no year takes the latest year that keeps the date ≤ `today`.
  - `type PageExpect = { identity: string; currency: Currency; referenceMinor: number | null; today: string }`
  - `judgePageRead(read: PageRead, expect: PageExpect): Judged`
    - `passed` only when every Global Constraints acceptance rule holds;
    - `feedback` names, in Finnish, the first rule that failed;
    - `score` is 1 for a single match with a price, else 0.
  - Constants: `IDENTITY_WINDOW_CHARS`, `PAGE_MAX_AGE_DAYS`.

- [ ] **Step 1: Write tests.** Hand-write a recipe per fixture.
  - `"reads the Nordnet NAV next to its ISIN"`: suomi fixture, identity `SE0005993102`, EUR. Expect one match, the price, and `identityNear`.
  - `"reads a SEK NAV as SEK"`: sverige fixture, identity `SE0002756973`.
  - `"reads OP's NAV with a yearless date"`: the OP fixture.
  - `"a yearless 31.12. read on 2 January is last year"`.
  - `"1 234,56 with a non-breaking space parses to 123456 minor"`.
  - `"a list page with two matching NAVs is refused"`: concatenate two fixtures. `judgePageRead` gives `passed: false` and feedback mentioning more than one match.
  - `"a match far from the ISIN is refused"`: pad more than 5000 chars between them.
  - `"wrong currency, a stale date, and a price 11x the reference are each refused"`.
  - `"a backtracking pattern is rejected by the schema"`.
- [ ] **Step 2: Run** `pnpm exec vitest run src/server/prices/page-recipe.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement.** Compile the pattern with the `u` flag and `g` for counting. `identityNear` checks `html.slice(match.index - W, match.index + match.length + W)`, case-insensitive.
- [ ] **Step 4: Run** the tests. Expect PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(prices): page recipes, run and checked by the app"`.

### Task 3: Asking for a page recipe

**Files:**

- Create: `src/server/prices/page-ask.ts`
- Test: `src/server/prices/page-ask.test.ts`

**Interfaces:**

- Consumes: `askForRecipe`, `ChatClient`, and everything from Task 2.
- Produces:
  - `pageSample(html: string, identity: string): string`
    - The raw-HTML windows (±2000 chars) around each case-insensitive occurrence of `identity`, joined with `\n…\n`.
    - Falls back to the first 40 000 chars when `identity` does not occur.
    - The sample is raw HTML, the same text the recipe runs on.
  - `writePageRecipe(html: string, expect: PageExpect, client: ChatClient): Promise<{ recipe: PageRecipe; price: FetchedPrice } | { error: string }>`
    - Returns `{ error }` with the last feedback when no attempt passes.
    - Never stores an unverified recipe.
  - Finnish instructions to the model that say:
    - patterns run against raw HTML;
    - JSON inside `<script>` is fair game;
    - name the groups `price` and `date`;
    - the date may have no year.

- [ ] **Step 1: Write tests** with a scripted `ChatClient` (as `src/server/import/recipe/*.test.ts` do).
  - `"a good first answer is returned with the price it read"`.
  - `"a wrong first answer gets feedback and the second passes"`: assert the second request's last user message contains the feedback.
  - `"no passing answer returns the reason"`.
  - `"the sample holds the text around the ISIN from deep in a large page"`: suomi fixture; the sample contains `navInfo`.
- [ ] **Step 2: Run.** Expect FAIL. **Step 3: Implement.** **Step 4: Run.** Expect PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(prices): ask the model for a page recipe"`.

### Task 4: The evening run reads pages

**Files:**

- Create: `src/server/prices/page.ts`
- Modify:
  - `src/server/prices/refresh.ts`: `refreshPrices` routes `page` instruments here; add `"page"` to `NEVER_BACKFILLABLE`; `runScheduledRefresh` builds the client lazily.
  - `src/server/prices/registry.ts`: replace the Task 1 placeholder.
- Test: `src/server/prices/page.test.ts`, plus additions to `refresh.test.ts`.

**Interfaces:**

- Consumes: Tasks 1–3; `writePrices`; `logAttempt`.
- Produces:
  - `refreshPage(db: Db, instrument: Instrument, opts: { fetchImpl: FetchImpl; client: ChatClient | null; today: string; now: number }): Promise<"ok" | "failed" | "attention">`. Rules:
    1. Fetch `sourceKey`.
    2. With a stored recipe, run it. If it **reads** (one match, identity near), write the point through `writePrices`, not `plausibleOnly`, so a re-baseline still counts. Clear `attention` to `ok`. Return `"ok"`.
    3. If it reads nothing (or there is no recipe), and `client` is not null, and `askedAt` is null or at least `PAGE_REASK_DAYS` old:
       - set `askedAt = now`;
       - call `writePageRecipe` with `referenceMinor` set to the latest stored price, or null;
       - on success, store the recipe and write the price;
       - on error, set `lookupStatus: "attention"` and write no price.
    4. Otherwise return `"failed"`, plus `"attention"` if the status is already attention.
  - `refreshPrices(db, opts)` gains `opts.client?: ChatClient | null`. Page instruments are run in sequence, `PAGE_SPACING_MS` apart, with `opts.pageSpacingMs` for tests.
  - `runScheduledRefresh` passes `createClient()`, or null when it throws, which is the missing-key case.

- [ ] **Step 1: Write tests.**
  - `"a stored recipe prices the page with no model call"`: scripted client that throws if called.
  - `"a recipe that reads nothing asks once, stores the new recipe and the price"`.
  - `"a failed ask marks attention and writes nothing"`.
  - `"the next night within 7 days makes no model call"`.
  - `"a good read later clears attention"`.
  - `"a 3-night consistent jump re-baselines a page instrument"`.
  - `"refreshPrices spaces page fetches and still runs Yahoo"`.
- [ ] **Step 2: Run** `pnpm exec vitest run src/server/prices`. Expect FAIL.
- [ ] **Step 3: Implement.** **Step 4: Run.** Expect PASS, and a clean `tsc`.
- [ ] **Step 5: Commit** with `git commit -m "feat(prices): evening run reads pages with stored recipes"`.

### Task 5: The lookup finds pages by web search

**Files:**

- Create: `src/server/instruments/find-page.ts`
- Modify:
  - `src/server/chat/runner.ts`: `TurnParams.tools` accepts the Claude API web search server tool. Check the current tool type and version with the `claude-api` skill before writing it.
  - `src/server/instruments/lookup.ts`, `lookup-cache.ts`, `auto-add.ts`, `resolve-pending.ts`.
  - `src/server/import/map.ts` and `txn-draft.ts`: `priceSource` enums gain `"page"`.
- Test: `src/server/instruments/find-page.test.ts`, plus additions to `lookup.test.ts`, `auto-add.test.ts` and `src/server/import/service.test.ts`.

**Interfaces:**

- Consumes: Tasks 2–3.
- Produces:
  - `type PageFinder = (q: { isin: string | null; name: string; currency: Currency | null }) => Promise<{ url: string; isin: string | null } | null>`
  - `webSearchFinder(client: ChatClient): PageFinder`. One model turn with the web search tool and structured output `{ url: string | null, isin: string | null }`. A thrown error propagates.
  - `lookupInstrument(isin, name, currency, fetchImpl, quoteSpacingMs?, page?: { find: PageFinder; client: ChatClient; referenceMinor: number | null })`. When `page` is given:
    - **No ISIN:** ask `find`. Use its `isin` only if that string occurs in the fetched page, then recurse with it (OpenFIGI, then Yahoo).
    - **OpenFIGI and Yahoo found nothing:** ask `find`, fetch the URL, and run `writePageRecipe`.
      - Verified: outcome `"found"`, `priceSource: "page"`, `sourceKey: url`, `pageRecipe: recipe`.
      - Not verified: `"form"` / `"nothing"`.
    - **`find` or the model throws:** outcome `"pending"`.
  - `InstrumentLookup` gains `pageRecipe: PageRecipe | null`. `priceSource` becomes `"yahoo" | "op_fund" | "page" | null`; `"op_fund"` is dropped in Task 7.
  - `rememberedLookup(…, page?)` passes `page` through. A `"found"` page result is cached with its recipe. A failed page is cached as `"form"`, so it is retried after 7 days.
  - `createAdded` writes `pageRecipes` for a created page instrument.
  - `resolveUnknown` passes `referenceMinor`, the first buy row's unit price for that ISIN or name, or null.
  - Production callers build `page` from `createClient()`. When that throws, they skip `page`, as today.

- [ ] **Step 1: Write tests.**
  - `"a fund OpenFIGI and Yahoo miss is found by web search and verified"`: the scripted finder returns the suomi fixture URL, and the stub fetch serves the fixture.
  - `"a found page whose recipe fails goes to the form"`.
  - `"an ISIN-less row gets its ISIN from the found page and is then priced by Yahoo"`.
  - `"an ISIN the page does not contain is not used"`.
  - `"the model failing at preview leaves the import committable with the instrument pending"`: import service, end to end.
  - `"a created page instrument has its recipe stored"`.
- [ ] **Step 2: Run** `pnpm exec vitest run src/server/instruments src/server/import`. Expect FAIL.
- [ ] **Step 3: Implement.** **Step 4: Run.** Expect PASS, and a clean `tsc`.
- [ ] **Step 5: Commit** with `git commit -m "feat(instruments): find price pages by web search"`.

### Task 6: A page URL typed by hand

**Files:**

- Modify:
  - `src/web/server/instruments.ts` (`createInstrument`, `editInstrument`);
  - `src/server/instruments/store.ts`;
  - `src/web/routes/UnknownInstrumentForm.tsx`;
  - the Muokkaa form in `src/web/routes/holdings.tsx` or its component.
- Test: additions to `src/server/instruments/store.test.ts` and the web route tests.

**Interfaces:**

- Consumes: `writePageRecipe`, `PageExpect`.
- Produces:
  - `checkPage(url: string, expect: PageExpect, fetchImpl: FetchImpl, client: ChatClient): Promise<{ recipe: PageRecipe; price: FetchedPrice } | { error: string }>` in `src/server/prices/page.ts`.
    - `url` must be `https:`.
    - A fetch failure is returned as `{ error }`.
  - With `priceSource: "page"`, `createInstrument` and `editInstrument`:
    - run `checkPage` inside the request, with `referenceMinor` set to the latest stored price, or null for a new instrument;
    - on error, answer 400 with the reason and save nothing;
    - on success, save the instrument, the recipe and the price, and return the price.
  - Both forms offer the option `{ id: "page", label: "Hintasivu (osoite)" }`. After saving they show `Luettu hinta: {price} {currency} ({date})`, or the error.
  - `instrumentLabel` (`src/web/routes/holdings-label.ts`) shows a `page` source as its host and path, without `https://` or the query: `https://www.nordnet.fi/rahastot/lista/x?y=1` → `www.nordnet.fi/rahastot/lista/x`.

- [ ] **Step 1: Write tests.**
  - `"saving a page URL stores the verified recipe and its price"`.
  - `"a page that cannot be read is refused and nothing changes"`.
  - `"a non-https URL is refused"`.
  - `"Muokkaa to a new URL replaces the recipe"`.
  - `instrumentLabel`: `"a page shows its host and path"`.
- [ ] **Step 2: Run.** Expect FAIL. **Step 3: Implement.** **Step 4: Run** `pnpm exec vitest run src/web src/server/instruments`. Expect PASS.
- [ ] **Step 5: Commit** with `git commit -m "feat(instruments): type a price page by hand, checked on save"`.

### Task 7: Move OP and Nordnet funds over, remove their readers

**Files:**

- Create: migration via `pnpm db:generate`, plus a hand-written data step in the same migration:

  ```sql
  UPDATE instruments SET price_source = 'page',
    source_key = 'https://www.op.fi/henkiloasiakkaat/saastot-ja-sijoitukset/rahastot/kaikki-rahastot/' || source_key
    WHERE price_source = 'op_fund';
  UPDATE instruments SET price_source = 'page',
    source_key = 'https://www.nordnet.fi/rahastot/lista/' || source_key
    WHERE price_source = 'nordnet_fund';
  ```

  Check that both prefixes match the URLs built in `funds.ts`. Moved instruments get no `pageRecipes` row. The first evening run writes one through Task 4's "no recipe" path, verified against the last stored price.

- Delete:
  - `NORDNET_FUND` and `OP_FUND` from `src/server/prices/funds.ts`. Move `MANUAL` into `src/server/prices/manual.ts` if `funds.ts` empties;
  - `src/server/instruments/op-slug.ts` and its use in `lookup.ts` (`viaOpFundPage`);
  - the enum values `op_fund` and `nordnet_fund` everywhere listed by `grep -rn "op_fund\|nordnet_fund" src`;
  - the `nordnet_fund` message in `refresh.ts`.
- Keep the HTML fixtures, which Tasks 2–3 use.
- Test: `src/server/db/migrate-fund-pages.test.ts`, and update the existing tests that name the removed sources.

**Interfaces:**

- Produces: `PriceSourceId = "yahoo" | "page" | "manual"`.

- [ ] **Step 1: Write tests.**
  - `"an op_fund row becomes a page with its full URL, and its prices stay"`: apply the migration's SQL to a seeded row.
  - `"a moved fund whose first recipe cannot be verified goes to attention and keeps its prices"`: through `refreshPage`.
- [ ] **Step 2: Run.** Expect FAIL. **Step 3: Implement**, then run `pnpm db:migrate:local`.
- [ ] **Step 4: Run** `pnpm run fmt && pnpm exec tsc --noEmit && pnpm exec oxlint --type-aware && pnpm exec vitest run`. Expect everything clean and passing.
- [ ] **Step 5: Commit** with `git commit -m "refactor(prices): OP and Nordnet funds are pages read by recipes"`.

### Task 8: Whole-suite check

- [ ] **Step 1:** Run `pnpm run fmt && pnpm exec tsc --noEmit && pnpm exec oxlint --type-aware && pnpm exec vitest run`. Expect everything clean and passing.
- [ ] **Step 2: Owner's manual check** (it writes to the real ledger and calls the model):
  - restart `pnpm run dev`;
  - in Muokkaa, set one moved fund's page and check that "Luettu hinta" shows its NAV;
  - trigger the evening run with `curl "http://localhost:3000/cdn-cgi/local/scheduled?cron=0+18+*+*+1-5"`, and check that the log shows page prices with no model call on the second run.

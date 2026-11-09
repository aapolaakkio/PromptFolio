# Price sources the AI finds, read by recipes

Date: 2026-11-09
Status: approved 2026-11-09

## Why

An instrument that OpenFIGI and Yahoo do not know ends up on the owner's own
price ("oma hinta") or in the unknown-instrument form. The owner's last such
case was a fund whose details came from Nordnet's page but that was not a
Nordnet fund. Today the app knows exactly two fund pages, OP's and Nordnet's,
each through a hand-written reader (`src/server/prices/funds.ts`, and the OP
slug discovery in `src/server/instruments/lookup.ts`). Any other fund company's
page is out of reach.

The owner already chose, for imports, that nothing is read by a built-in
parser: the model writes a recipe, the app verifies it, the recipe is stored
and reused. This brings price pages under the same rule.

## Goals

- **Two built-in sources only:** OpenFIGI (what an instrument is) and Yahoo
  (listed prices, including funds under `0P…` codes). Owner's decision.
- **Everything else is found:** when neither knows an instrument, Claude
  searches the web once for a public page showing its price, such as the fund
  company's own page, a bank's fund page, or a fund database.
- **Each page is read by a recipe:** the model describes how to read the
  price, its date and its currency from that page. The evening run reads the
  page with the stored recipe and makes no model call. The model is asked
  again only when the recipe stops reading the page.
- **The OP and Nordnet readers go away.** Instruments priced through them today
  move to page recipes (owner's decision: "Move over"), keeping their price
  history.
- **An OP paste row without an ISIN** is found the same way, by web search on
  its name, since the OP slug discovery goes away with the OP reader. The
  search is asked for the ISIN as well as a page. An ISIN is used only when it
  appears on the page the model returned. With an ISIN, the lookup runs the
  ordinary OpenFIGI and Yahoo pass again, so a fund Yahoo carries under `0P…`
  ends up on Yahoo, as OP funds usually do today. A page is used only when
  that pass finds nothing. _(Designer's call, so this is no regression from
  today's OP slug path.)_

## Non-goals

- Region or sector grouping. Asked; the owner does not need it.
- Replacing OpenFIGI or Yahoo.
- Price history backfill from pages. A page gives today's price, and history
  builds up day by day, as the Nordnet reader already does.
- Pages that need a login or that render their price only with JavaScript.
  The model may still pick one, but its recipe will fail verification, and the
  instrument falls to the form (or "Hintalähdettä ei löytynyt").

## Anti-goals

- **A wrong price that hides.** A recipe that reads the wrong number, such as a
  sister fund's NAV, a percentage, or yesterday's price, and stores it quietly.
- **A model call every night.** Daily pricing must cost no model call while
  the recipe still works.
- **Getting around a site's limits** (spoofing, rotating identities). This
  carries over from Yahoo. One request per page per evening run.
- **A blocked import.** The model being down or slow at import time must not
  stop an import; the instrument becomes pending, as with a Yahoo pause.

## How it works

### Finding a page

Lookup order for an unknown instrument: OpenFIGI, then Yahoo (as today). When
those come up empty, the app asks Claude, using the Claude API's web search
through the existing AI Gateway client (`src/server/chat/runner.ts`). It passes
the ISIN (or the name, for an ISIN-less row), the name, and the holding's
currency, and asks for one public page URL that shows this instrument's
current price.

The answer is remembered in the existing lookup cache (`instrument_lookups`)
under the same rules: found is kept; nothing found is retried after 7 days.
So Claude is asked at most once per instrument per week. A page counts as
**found only once its recipe has been verified** (below). A URL whose recipe
fails is stored as "nothing found", so it is searched again after 7 days and
never sticks. The verified recipe is stored with the instrument, not in the
cache, because verification depends on the holding's currency and price.
_(Designer's call.)_

### Reading a page: the page recipe

The app fetches the page itself (a plain GET, no cookies) and gives the model
a sample of it. The model returns a recipe: patterns that pick out the price,
its date, and its currency. This works like `broker-record` patterns, with the
same safety checks (`pattern-safety.ts`, length caps).

A recipe is accepted only when, run by the app against the fetched page:

1. it yields exactly one price, a date, and a currency, and an identity
   anchor: the instrument's ISIN, or for an ISIN-less row its name, found on
   the page by the recipe. This is what keeps a sister fund's NAV out. The
   price check below is too loose to catch one, and the OP and Nordnet
   readers being removed both check identity today. _(Designer's call.)_
2. the currency equals the holding's currency;
3. the date is recent (within about 10 days; builder's call within that bound);
4. the price is plausible: within the existing plausibility rule of
   `src/server/prices/write.ts` against the last stored price, or, for a new
   instrument, against the unit price of its purchase rows in the import.

When the first recipe fails, the model gets the failure as feedback, as
`askForRecipe` does now, for a bounded number of attempts.

Pages can be large (a Nordnet fund page is about 1.8 MB of mostly hydration
state). How the sample is cut down is left to the builder, for example by
stripping scripts and styles or by showing the text around the ISIN and name.
Patterns run against the raw page, so the sample and the run must agree on what
the page text is.

### Storing it

- New `price_source` value `page`. `source_key` is the page URL. The recipe is
  stored per instrument, not per user, because instruments are shared by the
  household as today. Schema is the builder's call.
- The URL is shown on Omistukset where the ticker is shown, shortened to its
  host and path.
- **Typing a page by hand (owner's decision):** the unknown-instrument form and
  Muokkaa offer "Hintasivu (osoite)" in place of today's "Nordnet-rahasto" and
  "OP-rahasto" slug choices. On save, the app fetches the page and writes and
  verifies its recipe right away, inside the request, and shows the price it
  read or why it failed. A page that fails is not saved as the price source.
  A changed URL in Muokkaa drops the old recipe and goes through the same
  check.

### The evening run

For each held `page` instrument: fetch the page, run the stored recipe, and
write the price through the existing plausibility rules (`write.ts`),
including its re-baseline rule, so a real split is still accepted after three
consistent readings. The model is asked for a new recipe only when the stored
recipe **reads nothing** (no match, or no identity anchor), never because of
plausibility alone. If the new recipe also fails verification, the
instrument's `lookupStatus` becomes `attention`, which shows the existing
"Hintalähdettä ei löytynyt – Muokkaa" note, and no price is written.

On later nights an `attention` page instrument is still fetched and read with
its stored recipe, with no model call. A successful read clears `attention`.
The model is asked again for it at most once every 7 days, matching the
lookup cache's retry. A Muokkaa edit clears it too, as today. _(Designer's
call: this keeps "no model call every night".)_

One request per page per run. Pages are fetched one after another, spaced
apart like the Yahoo fallback. Builder's call on spacing and on whether a
host that answers 429 is paused the way Yahoo is.

### Moving OP and Nordnet funds over

A one-time step, run by the first evening run after deploy or by a migration
step (builder's call):

- an `op_fund` / `nordnet_fund` instrument becomes `page`, with `source_key`
  set to the URL its old reader fetched (both URLs are built from the slug
  today);
- its recipe is written on that first run against the live page, verified
  against its last stored price;
- prices already stored stay;
- if the recipe cannot be verified, the instrument goes to `attention`; it is
  not deleted and keeps its stored prices.

After the move, `funds.ts`'s OP and Nordnet readers and the `op_fund` and
`nordnet_fund` enum values are removed. Their fixtures stay useful as test
pages for the recipe runner.

### Spotting a wrong choice

This uses the mechanism already built: the source code (now a URL) under the
holding's name on Omistukset, and Muokkaa to fix it. Nothing new. Owner
confirmed.

## Constraints

- Cloudflare Workers + D1, as today. The model is reached through the existing
  AI Gateway client.
- Tests never reach the network; page fetches and model calls are injected, as
  the project does now.
- No new dependencies unless an HTML-to-text step really needs one (builder's
  call; prefer a few lines).
- Finnish UI copy.

## What the owner decided

- Only OpenFIGI and Yahoo built in; everything else found from the internet.
- Existing OP and Nordnet funds move over.
- A wrong page is noticed and fixed the same way as a wrong ticker.
- No region or sector grouping.
- A page URL can be typed in the form and in Muokkaa; its recipe is written
  and checked on save.

## Left to the builder

- The web search call's exact shape (tool version, prompt).
- Recipe format, sample cutting, attempt count.
- Schema for the page recipe.
- Spacing and 429 handling for page fetches.
- How the one-time move runs.

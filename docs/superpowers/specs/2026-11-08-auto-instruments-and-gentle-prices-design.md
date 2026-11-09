# Instruments that add themselves, and prices without 429s

Date: 2026-11-08
Status: approved 2026-11-08

## Why

Two annoyances with one root cause.

1. **Importing stops at forms.** Every ISIN the app has not seen opens an
   "unknown instrument" form the owner fills in or confirms. The owner wants an
   import to just work: every new fund, ETF or share added on its own.
2. **Prices do not arrive.** Yahoo answers `429 Too Many Requests`, so listed
   holdings (Finnair, Nokia, Konecranes, Reaktor, the ETFs) have had no price
   for days, and the forms above say "Rekistereistä ei löytynyt tietoja"
   because the Yahoo half of the lookup is refused too.

Both come from asking Yahoo one question at a time. A single new ISIN probes up
to eight candidate symbols, each a separate request; every refresh asks once
per holding; every form on the import screen fires its own lookup. The fix is
asking far less often, not asking differently.

## Goals

- **An import adds new instruments itself.** The preview resolves every unknown
  ISIN on the server and creates the instrument when the lookup finds a price
  source. No form, no confirmation.
- **The form is a last resort.** It appears only for an instrument no source
  knows (for example a fund Yahoo does not carry and that has no OP page).
- **A wrong choice is visible.** The ticker (source code) and quotation
  currency are shown wherever a holding appears, so a USD listing chosen for a
  EUR holding stands out. The owner fixes it with the existing Muokkaa form.
- **Fresh prices for traded holdings.** Listed shares and ETFs refresh every
  hour while their exchange is open. Funds keep their once-a-day NAV.
- **No more 429s in normal use.** All listed holdings' prices come from one
  Yahoo request per run. A 429 pauses Yahoo use for a while instead of being
  retried.
- **Each ISIN is looked up once.** The answer is remembered, including "nothing
  found", so an import of the same file does not ask again.

## Non-goals

- Paid data services. Researched 2026-11-08: free tiers (Twelve Data, Alpha
  Vantage, EODHD) are US-only or capped at 20-25 requests a day, so none gives
  free intraday prices for Helsinki and Xetra. Yahoo stays the source.
- Real-time or tick prices. Hourly is the target.
- Exchange holiday calendars. A run on a holiday finds an unchanged price and
  costs one request.
- Automating Nordnet fund page codes. Nordnet's ISIN search needs a login;
  Nordnet funds are priced through Yahoo's `0P...` symbols instead, as the
  lookup already prefers.

## Anti-goals

These would make it a failure even if it technically worked:

- **Getting around Yahoo's limits** (rotating identities, spoofing, retrying
  through a 429). The answer to a 429 is to wait.
- **A wrong listing that hides.** An auto-added instrument whose ticker and
  currency appear nowhere the owner looks.
- **A blocked import.** Yahoo being paused at import time must not stop the
  owner from importing.

## How it works

### 1. One gate for every Yahoo call

All Yahoo requests (prices, history backfill, search, listing probes) go
through one gate:

- It remembers, in D1, a **pause-until time**. A 429 sets it, using
  `Retry-After` when present, otherwise a back-off that doubles on each
  consecutive 429 (start around 15 minutes, cap around 6 hours). A successful
  request resets the back-off.
- While paused, a Yahoo call returns "paused" immediately, without a request.
  Callers treat that as "try later", never as "not found".

### 2. Batch quotes

Prices for many symbols come from one request. The candidate is Yahoo's spark
endpoint, `https://query1.finance.yahoo.com/v8/finance/spark?symbols=A,B,C&range=1d&interval=1d`,
which returns each symbol's latest close and currency. **The builder verifies it
answers without a session cookie or crumb.** If it does not, the fallback is the
existing per-symbol chart call, spaced out (a few seconds apart) and capped per
run, so a run of 20 holdings is still gentle. Whichever is used, it sits behind
the gate.

The same batch call serves the lookup's listing probe: the up-to-eight candidate
symbols for a new ISIN are checked in one request instead of eight.

### 3. When prices are fetched

- **Every hour on weekdays** (Cron Trigger `0 0-17,19-23 * * 1-5`, skipping
  18:00 UTC when the evening run fires): fetch, in one
  batch, every Yahoo-priced holding whose exchange is open right now. The
  exchange comes from the symbol's suffix: `.HE` Helsinki, `.DE` Xetra, `.ST`
  Stockholm and so on, and no suffix for the US. Opening hours are a small table
  (local time, with the time zone so daylight saving is right), e.g. Helsinki
  10:00-18:30 Europe/Helsinki, Xetra 09:00-17:30 Europe/Berlin, NYSE/Nasdaq
  09:30-16:00 America/New_York. A run with no open exchange makes no request.
- **The existing weekday 18:00 UTC run** keeps everything else: fund NAVs (OP,
  Nordnet), FX rates, history backfill, and a final close for every listed
  holding.
- **"Päivitä hinnat"** runs the same as the evening run, through the gate.

A price fetched during the day is stored under today's date and overwritten by
later runs the same day; the stored price stays one per instrument per day.

### 4. Adding instruments during import

When a preview finds ISINs the ledger does not know:

1. The server looks each one up **once**, in the preview request, deduplicated
   across the file. The lookup is the existing `lookupInstrument` (OpenFIGI for
   kind, name and venues; Yahoo for the listing in the holding's currency; OP's
   fund page as the last resort), with its Yahoo calls batched and gated.
2. The answer is remembered in a lookup cache (ISIN, or name for an ISIN-less
   OP row: result, when it was asked). A "found" answer is permanent. "Nothing
   found" is retried after about a week, so a newly listed security eventually
   resolves.
3. **Found, in the holding's own currency, by ISIN:** the preview treats it as
   known and lists it as "will be added". The instrument is **created when the
   import is committed**, not in the preview, so a preview that is cancelled
   leaves nothing behind (the lookup cache is the preview's only write). Its
   history backfill is queued for the evening run.
4. **Goes to the form (owner's decision):**
   - the only listing found is in **another currency** than the holding (e.g. a
     USD line for a EUR holding): adding it would put the broker's EUR purchase
     prices and a USD price feed on one instrument and misvalue it;
   - a row with **no ISIN** (OP's paste) resolved by **name search**, which can
     pick a different company. OP funds are not affected: their OP page gives
     the ISIN, which then takes the ordinary path.
5. **Nothing knows it:** it stays unknown, and the preview shows today's form
   for it.
6. **Yahoo paused at preview time:** the import is not blocked. At commit the
   instrument is created from what is known (the broker's name, the row's
   currency, OpenFIGI's kind when it answered) with a **lookup pending**
   status and no price source yet. The next run that finds Yahoo unpaused
   finishes the lookup. _(Builder's call how "pending" fits the NOT NULL
   `price_source` / `source_key` / `kind` columns, e.g. a status column plus
   `manual` and a placeholder until resolved.)_
7. **A pending lookup that ends in a form case** (nothing found, another
   currency, or name-only): the form can no longer appear, since the import is
   committed. The instrument stays on the owner's own price, and Omistukset
   shows a "Hintalähdettä ei löytynyt – Muokkaa" note on it, the after-the-fact
   form. _(Designer's call.)_
8. **A late lookup never overwrites** a source, code or currency the owner set
   in Muokkaa in the meantime. _(Designer's call.)_

An instrument with a pending lookup appears on Omistukset like any other, with a
"haetaan tunnusta" note where the ticker would be.

**Price runs skip instruments nobody holds** (no open position in any account),
so an instrument left over from an undone import costs no requests.
_(Designer's call.)_

### 5. Showing what was chosen

- **Omistukset:** under each holding's name, beside the ISIN, show the ticker
  (or source code) and quotation currency, e.g. `FI4000567029 · FIA1S.HE · EUR`.
- **Import preview:** a short list of the instruments the import added, each
  as name, ticker and currency, with a link to Muokkaa. This replaces the forms
  for everything that resolved.
- **Muokkaa** (exists) corrects currency, source and code.

## Constraints

- Runs on Cloudflare Workers with D1, as today. Cron triggers are free on the
  Workers plan in use; an hourly trigger is about 24 invocations a weekday, most
  of them making no request.
- Tests never reach the network: every fetch is injected, as the project does
  now.
- Existing data keeps working: instruments added by hand keep their sources,
  and the evening run behaves as now apart from being gated.

## What the owner decided

- Auto-add with no confirmation; the form only when nothing finds the
  instrument, when the only listing is in another currency than the holding,
  or when a row without an ISIN was found by name search.
- Mistakes are caught by showing the ticker and currency, not by asking.
- Listed holdings every hour in market hours; funds daily. (Originally every
  15 minutes; the owner changed it to hourly on 2026-11-09.)
- A free API key would be acceptable, but research found none that fits; Yahoo
  stays, used far less often.

## Left to the builder

- Whether the spark endpoint works without a crumb, and the fallback if not.
- The exact back-off numbers within the bounds above.
- Schema for the gate state, the lookup cache and the "lookup pending" mark.
- How many backfills the evening run does at most, if any cap is needed.
- Wording of the new labels.

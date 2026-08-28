# PromptFolio Phase 2 — handover

Written 2026-08-28. Phase 2 is reconciliation and PDF import; vision import was
dropped (spec 10c/C8). 558 tests passing, merged to `master`.

## What it does

A broker's holdings statement says what you held on a date. The app compares that
against what your own transactions add up to for the same date and shows the
differences. It resolves none of them by itself.

- **/reconcile** — pick an account and a statement, see a row per instrument:
  what the ledger derives, what the statement says, the delta, and what that
  difference most likely means.
- **Upload a PDF** — OP's year-end statement is read directly. It has a real text
  layer, so no model, no API key and no per-page cost.
- **Type one in by hand** — same shape, for a broker whose statement this cannot
  read.
- **Resolve a row** — accept a difference and it becomes an adjusting
  transaction, one row at a time.

## The rules it holds to

**A statement never becomes transactions on its own.** It produces a *snapshot*,
which is evidence to check the ledger against. The worst a misread statement can
do is show a difference you dismiss. A test asserts the transaction count is
unchanged across a reconciliation that reports a five-unit gap.

**An adjustment never invents a cost basis.** Adding units requires an
acquisition value and is refused without one, in the API and in the form. A zero
default would report the holding's entire future value as gain, and nothing
downstream would flag it.

**An adjustment stays identifiable.** Every one carries
`externalId = adjustment:<snapshotId>:<instrumentId>` and a note naming its
statement, so it never blends in with imported rows. That id also makes it
idempotent: adjusting the same row twice is a conflict, not a second phantom
holding.

**Deleting a statement does not retract its adjustments.** Housekeeping must not
change holdings as a side effect. The transaction stays, still naming a statement
that no longer exists.

**A row the parser cannot match is not guessed at.** A statement names funds the
way the broker prints them — one real statement says
`OP-MAAILMA INDEKSI -SIJOITUSRAHASTO A` for a holding registered as
`OP-MAAILMA INDEKSI A`. Matching strips the broker's own suffixes and then
demands an exact hit; anything else waits for you.

## Also fixed in this phase

- **An import files its rows into the accounts they belong to.** A Nordnet export
  routinely covers several accounts, and the importer used to merge them. This
  was the top-ranked gap from phase 1, and reconciliation would have inherited
  it: a statement covers one account, so a merged ledger reports every holding of
  the other as a phantom difference.
- **A foreign-exchange rate more than ten days stale is refused.** The last of the
  four ways this project produced a confident, plausible, wrong number with
  nothing flagged. Checked against a real ledger: no day gains an exclusion and
  the time-weighted return is unchanged.

## Known gaps

1. **Re-import your Nordnet data.** The account split applies at import time, so
   an already-merged ledger stays merged until the import is redone.
2. **`unit_price` is stored in the row's cash currency, not the instrument's.**
   Cost basis is derived from `amount` and is unaffected; this is a display
   defect, and nothing currently displays it.
3. **Account type (AOT vs OST) does not exist in the model** — spec 10c/C7,
   deliberately deferred. Phase 4's tax reporting needs it.
4. **Cash holdings are not counted** — spec 10c/C2. The open question is not
   storage but whether cash belongs in value, allocation and returns at all.
5. **`bun run dev`** bundles and serves cleanly now, but the browser-side failure
   it had in phase 1 could not be re-checked without a browser. Worth trying.
6. **`@tanstack/react-table`** is installed and unused.

## Where things are

- Spec: `docs/superpowers/specs/2026-08-27-portfolio-manager-design.md`. §5.2 and
  §5.4 design this phase; 10c/C8 records dropping vision.
- Phase 1's handover, still accurate for the ledger and imports:
  `docs/PHASE-1-HANDOVER.md`.
- Phase 3 onward, unstarted: AI chat, Finnish tax reporting, rebalancing. The
  chat is the first feature that needs an API key at all.

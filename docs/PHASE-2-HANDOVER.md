# PromptFolio Phase 2 — handover

Written 2026-08-28, revised 2026-08-29 once both brokers' real exports had been
run through it. Phase 2 is reconciliation and holdings import. Vision import was
dropped (spec 10c/C8), and so was the PDF path (C9). 575 tests passing.

## What it does

A broker's holdings statement says what you held on a date. The app compares that
against what your own transactions add up to for the same date and shows the
differences. It resolves none of them by itself.

- **/reconcile** — pick an account and a statement, see a row per instrument:
  what the ledger derives, what the statement says, the delta, and what that
  difference most likely means.
- **Upload a holdings export** — Nordnet publishes a CSV; it is read directly,
  including its UTF-16 encoding.
- **Paste a holdings table** — OP publishes no export, but its holdings view
  copies as text, in sections, and is read by shape.
- **Type one in by hand** — same shape again, for anything neither route covers.
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
way the broker prints them, which is not always how they are registered here.
Matching strips the broker's own suffixes and then demands an exact hit; anything
else waits for you.

**Columns are found by heading, rows by shape.** A CSV's columns are matched by
their heading, never their position: a broker reordering them would otherwise
file a market value as a quantity in silence. A pasted table has no columns at
all, so a row is a name followed by exactly the figures the table prints, and a
row with a different count is reported rather than absorbed.

## Also fixed in this phase

- **A foreign-exchange rate more than ten days stale is refused.** The last of the
  four ways this project produced a confident, plausible, wrong number with
  nothing flagged. Checked against a real ledger: no day gains an exclusion and
  the time-weighted return is unchanged.

## Known gaps

1. **A broker export covering several accounts is still merged into one.** An
   attempt to split it automatically was built and reverted: filing rows into
   accounts the importer invents is the wrong answer. The intended workflow is
   that each account is exported and imported separately. Nothing currently
   detects a file that spans two, so it merges silently -- and reconciliation
   inherits that, since a statement covers one account and a merged ledger
   reports every holding of the other as a phantom difference.
2. **`unit_price` is stored in the row's cash currency, not the instrument's.**
   Cost basis is derived from `amount` and is unaffected; this is a display
   defect, and nothing currently displays it.
3. **Account type (AOT vs OST) does not exist in the model** — spec 10c/C7,
   deliberately deferred. Phase 4's tax reporting needs it.
4. **Cash holdings are not counted** — spec 10c/C2. The open question is not
   storage but whether cash belongs in value, allocation and returns at all.
5. **`bun run dev`** bundles and serves cleanly now, but the browser-side failure
   it had in phase 1 could not be re-checked without a browser. Worth trying.
6. **Nordnet transactions need re-importing.** The Nordnet accounts were deleted
   after an automatic account-split attempt was reverted; only OP's 161
   transactions remain. Import each Nordnet account separately.

## Where things are

- Spec: `docs/superpowers/specs/2026-08-27-portfolio-manager-design.md`. §5.2 and
  §5.4 design this phase; 10c/C8 records dropping vision.
- Phase 1's handover, still accurate for the ledger and imports:
  `docs/PHASE-1-HANDOVER.md`.
- Phase 3 onward, unstarted: AI chat, Finnish tax reporting, rebalancing. The
  chat is the first feature that needs an API key at all.

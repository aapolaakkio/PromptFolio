---
name: comments
description: Use when writing or editing code in this repo — keeps code comments rare and short instead of narrating every function.
---

# Comments

Write few comments. Keep each one short.

## The rule

A comment earns its place only when the code cannot say the thing itself:

- a non-obvious *why* (a workaround, a regulation, a rounding rule, an order that matters)
- a trap the next reader would otherwise fall into
- a `SAFETY:` note on something that must not be changed casually

Everything else is noise. A name, a type, or a test says it better and never
goes stale.

## Length

One line. Two if the reason genuinely needs it. Never a paragraph above a
function explaining what the function does — that is what the signature is for.

## Do not write

- Restatements: `// opens the account` above `openAccount`
- Migration narration: `// this is a server function now, which a separate test process cannot call`
- Sectioning: `// --- helpers ---`
- JSDoc on every export just because the neighbours have it
- Comments on test fixtures explaining what the fixture obviously is

## Do write

```ts
// Nordnet reports the settlement date, not the trade date, on FX rows.
const traded = row.settled;

// SAFETY: lots are FIFO by law here; do not sort by cost.
```

## When editing existing code

Match what the surrounding file already does — do not bulk-add comments to a
file that has none, and do not strip existing ones that carry a real *why*
(especially `SAFETY:` notes). Delete a comment only when it is wrong or
restates its own line.

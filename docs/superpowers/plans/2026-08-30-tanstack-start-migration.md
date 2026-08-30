# Moving off Bun to TanStack Start on Vite

**Goal:** replace Bun entirely — bundler, runtime, test runner, package manager — with
TanStack Start on Vite, Node, Vitest and pnpm.

**Why:** `bun run dev` cannot hot-reload the frontend. Bun 1.4's dev server wraps each
module for HMR, and `@tanstack/router-core` contains a circular import (`router.js` ↔
`load-client.js`) that the wrapper resolves to `null`, killing the page on load with
`Cannot read properties of null (reading 'replaceRouteChunk')`. Reproduced in a real
browser; no released Bun or router version fixes it, and Bun's own issue tracker offers
only "turn HMR off". Vite does not have the bug.

## The stack, after

| Concern | Before | After |
|---|---|---|
| Bundler & dev server | `Bun.build`, HTML imports | Vite 8 + TanStack Start (SPA mode) |
| Runtime | Bun | Node 24 (22.12 works but needs `--experimental-sqlite`) |
| HTTP | `Bun.serve` routes | Start server functions; routes only where a URL is the contract |
| SQLite | `bun:sqlite` | `node:sqlite` + `drizzle-orm/node-sqlite` |
| Tests | `bun test`, 1 098 of them | Vitest (same `describe`/`test`/`expect`) |
| Package manager | `bun install` | pnpm |
| Password hashing | `Bun.password` | `@node-rs/argon2` |

## What the spike established

Run for real before planning further, in a throwaway Start app:

- **The SSE chat stream survives.** A server route returning a `Response` over a
  `ReadableStream` streamed `data: tick 1`, `data: tick 2` as expected. This was the risk
  that could have ended the migration.
- **Handlers keep their shape.** Server routes receive a web `Request` and return a
  `Response` — the signature every handler in `src/server/api/` already has.
- **Existing logins keep working.** `@node-rs/argon2` verified a hash made by
  `Bun.password` (`true` for the right password, `false` for the wrong one). Nothing about
  password storage has to change.
- **`node:sqlite` works and drizzle has a driver for it** (`drizzle-orm/node-sqlite`, in
  the installed version). No native addon, so no compile step in Docker.
- **better-sqlite3 is not an option here.** It segfaults this machine's Node 22.12 even
  outside Vite, and took the dev server down with it. Ruled out by measurement, not taste.
- **`bun:sqlite` cannot work under Vite at all**, whoever launches it: Vite loads server
  modules through Node's ESM loader, which rejects the `bun:` scheme. Moot now that Bun is
  going, but it is why a half-migration was never available.
- **The router entry must export `getRouter`** in Start 1.168, not `createRouter`.

## Stages

Each ends with the suite green and a commit. Nothing is half-migrated at a boundary.

**1. pnpm.** Drop `bun.lock`, add `pnpm-lock.yaml` and `.npmrc`. Scripts still call Bun.

**2. Node runtime shims.** `Bun.env` → `process.env`, `Bun.file` → `node:fs/promises`,
`Bun.CryptoHasher` → `node:crypto`, `Bun.spawn` → `node:child_process`, `Bun.password` →
`@node-rs/argon2`. 98 files touch these; each change is local.

**3. SQLite.** `bun:sqlite` → `node:sqlite`, `drizzle-orm/bun-sqlite` →
`drizzle-orm/node-sqlite`. Five files, plus the migration runner.

**4. Vitest.** 84 test files move from `bun:test` to Vitest — the imports change, the
assertions do not; the suite uses no Bun-specific test API beyond `toMatchObject`, which
Vitest has. The preload that makes `fetch` throw becomes `setupFiles`, and the 80 %
per-file coverage floor becomes a Vitest threshold.

*Ordering, corrected after stage 1:* Vitest was going to come first, as the biggest
mechanical step and the one most easily verified alone. It cannot. Vitest runs tests under
Node, so every Bun API the code under test imports has to be gone before the runner
changes — otherwise nothing runs at all and there is no green suite to verify against.
The shims and the SQLite driver therefore go first, and both are verifiable under
`bun test` because Bun implements `node:sqlite` too. The runner changes last, when the
code it runs no longer needs Bun.

**5. Vite and Start.** Done. `vite.config.ts` with `tanstackStart`, `@vitejs/plugin-react`
and `@tailwindcss/vite`; `build.ts`, `main.tsx`, `index.html` and the code-based route
tree deleted. Routes are files under `src/web/app`, each pointing at the page component
that already existed, and `routes.test.ts` inherits `route-tree.test.ts`'s job of proving
every screen is reachable and points at itself.

**6. Session on the server.** The authenticated layout gates in the browser, so SSR
currently renders a loading state for every page. `beforeLoad` plus a server function
that reads the session cookie turns that into a real render or a redirect.

**7. The API becomes server functions.** Not 44 route files -- server functions,
which is what Start is for. `createServerFn({ method }).validator(Schema).handler(fn)`
takes the existing zod schema as its validator and the existing handler body almost
unchanged, and the client calls it as a typed function instead of assembling a URL.

What that deletes is the point: every `apiGet("/api/holdings", HoldingsSchema)` on the
client, and with it the second copy of each schema that exists only to parse a response
the server just serialised. A field renamed on the server becomes a type error in the
component rather than a zod failure at runtime -- which is exactly the class of bug that
blanked Käteinen and Täsmäytys when one account type went unrecognised.

Three things stay real HTTP routes, each for a reason:

- **`/api/auth/*`** -- Better Auth's own client calls those exact URLs. A server function
  is reachable only through Start's RPC endpoint, so this is not portable.
- **`/api/health`** -- a URL is the interface. Docker and any uptime check want to curl it.
- **The chat stream** -- and it turns out this one does *not* have to stay a route.
  `createServerFn({ method: "GET", response: "raw" })` returning a `Response` over a
  `ReadableStream` streams incrementally: the spike's three ticks arrived 0.4 s apart,
  which is the delay the handler put between them. So the chat becomes a server function
  like everything else.

  Worth knowing from the same probe: the RPC endpoint answers **403 without an `Origin`
  header**. Server functions are origin-guarded by default, which is a property this app
  wants and did not have before.

The tests move with them, and get shorter: a test that builds a `Request`, calls
`accountRoutes["/api/accounts"].POST(...)` and parses JSON back becomes a call to the
function with an argument. Roughly 30 test files, mechanical but not trivial, and each
one loses its hand-written request plumbing.

**8. The rest of the server.** What Start does not own: migrate-on-boot, the nightly price
refresh, the unhandled-rejection guard.

**9. Docker and docs.** `oven/bun` → `node:24`, README, HANDOVER.

## What must not regress

- **1 098 tests and the 80 % per-file coverage floor.**
- **No test may reach the network.** The guard that replaces `fetch` has to survive
  the move to Vitest.
- **The SSE chat stream**, and the long idle it needs. Bun needed `idleTimeout: 255`;
  Node's server has its own timeouts to set.
- **Existing logins** — proven safe above, and to be re-proven by a test.
- **Money handling.** `bigint` minor units, `parseScaled`, decimal strings on the wire.
  None of it is runtime-specific, and none of it changes.

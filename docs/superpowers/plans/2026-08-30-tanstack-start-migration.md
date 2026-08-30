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
| HTTP | `Bun.serve` routes | Start server routes, file-based |
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

**2. Vitest.** 84 test files move from `bun:test` to Vitest — the imports change, the
assertions do not. The preload that makes `fetch` throw becomes `setupFiles`; the 80 %
per-file coverage floor becomes a Vitest threshold. This is the largest mechanical step
and it is independent of everything else, so it goes early where it can be verified alone.

**3. Node runtime shims.** `Bun.env` → `process.env`, `Bun.file` → `node:fs/promises`,
`Bun.CryptoHasher` → `node:crypto`, `Bun.spawn` → `node:child_process`, `Bun.password` →
`@node-rs/argon2`. 98 files touch these; each change is local.

**4. SQLite.** `bun:sqlite` → `node:sqlite`, `drizzle-orm/bun-sqlite` →
`drizzle-orm/node-sqlite`. Five files, plus the migration runner.

**5. Vite and Start.** `vite.config.ts` with `tanstackStart({ spa: { enabled: true } })`,
`@vitejs/plugin-react`, `@tailwindcss/vite`. `build.ts` and `bun-plugin-tailwind` go.

**6. Frontend routes.** The code-based tree in `route-tree.ts` becomes files under
`src/routes/`. `route-tree.test.ts` tests structure with stub components and must keep
doing so, or the split it exists for is lost.

**7. API routes.** 44 handlers, one file each: `/api/health` → `src/routes/api/health.ts`,
`/api/accounts/:id` → `api/accounts/$id.ts`, `/api/auth/*` → `api/auth/$.ts`. The bodies
do not change.

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
